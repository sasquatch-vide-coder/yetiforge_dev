import { spawn } from "child_process";
import { Config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface ClaudeResult {
  result: string;
  sessionId: string;
  costUsd?: number;
  duration?: number;
  isError: boolean;
}

export interface InvokeOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
  config: Config;
  onInvocation?: (raw: any) => void;
  systemPrompt?: string;
  model?: string;
  timeoutMsOverride?: number;
  /** Restrict available tools. Empty string disables all tools. */
  allowedTools?: string;
  /** Called whenever the child process produces stdout/stderr output — useful for activity tracking */
  onActivity?: () => void;
  /** Called with raw output chunks from stdout/stderr — useful for feeding output to the agent registry */
  onOutput?: (chunk: string) => void;
}

export async function invokeClaude(opts: InvokeOptions): Promise<ClaudeResult> {
  try {
    return await invokeClaudeInternal(opts);
  } catch (err: any) {
    // If resume failed, retry without session
    if (opts.sessionId && isSessionError(err)) {
      logger.warn({ sessionId: opts.sessionId }, "Session expired, retrying without resume");
      return invokeClaudeInternal({ ...opts, sessionId: undefined });
    }
    throw err;
  }
}

function isSessionError(err: any): boolean {
  const msg = String(err?.message || err);
  return (
    msg.includes("session") ||
    msg.includes("resume") ||
    msg.includes("not found") ||
    msg.includes("invalid")
  );
}

function invokeClaudeInternal(opts: InvokeOptions): Promise<ClaudeResult> {
  const { prompt, cwd, sessionId, abortSignal, config } = opts;

  return new Promise((resolve, reject) => {
    const args: string[] = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];

    if (opts.systemPrompt) {
      args.push("--system-prompt", opts.systemPrompt);
    }

    if (opts.model) {
      args.push("--model", opts.model);
    }

    if (opts.allowedTools !== undefined) {
      args.push("--tools", opts.allowedTools);
    }

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    logger.debug({ args, cwd }, "Spawning Claude CLI");

    const proc = spawn(config.claudeCliPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal: abortSignal,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      opts.onActivity?.();
      opts.onOutput?.(text);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      opts.onActivity?.();
      opts.onOutput?.(text);
    });

    // Timeout (0 = no timeout)
    const effectiveTimeout = opts.timeoutMsOverride ?? config.claudeTimeoutMs;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    if (effectiveTimeout > 0) {
      timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Claude CLI timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
    }

    proc.on("close", (code) => {
      if (timeout) clearTimeout(timeout);

      if (abortSignal?.aborted) {
        reject(new Error("Cancelled"));
        return;
      }

      if (stderr) {
        logger.debug({ stderr }, "Claude CLI stderr");
      }

      if (code !== 0 && !stdout) {
        const errMsg = stderr || `Claude CLI exited with code ${code}`;
        // Check for rate limit
        if (stderr.includes("rate limit") || stderr.includes("429")) {
          reject(new Error(`Rate limited: ${errMsg}`));
          return;
        }
        reject(new Error(errMsg));
        return;
      }

      try {
        const parsed = parseClaudeOutput(stdout, opts.onInvocation);
        resolve(parsed);
      } catch (parseErr) {
        // If JSON parse fails, return raw stdout as result
        if (stdout.trim()) {
          resolve({
            result: stdout.trim(),
            sessionId: sessionId || "",
            isError: false,
          });
        } else {
          reject(parseErr);
        }
      }
    });

    proc.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
  });
}

function parseClaudeOutput(raw: string, onInvocation?: (raw: any) => void): ClaudeResult {
  // stream-json format: one JSON object per line (NDJSON)
  // We need to find the last "result" type object for the final answer
  const lines = raw.split("\n").filter((l) => l.trim());

  // Parse all JSON lines, collecting them
  const parsed: any[] = [];
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("{")) continue;
    try {
      parsed.push(JSON.parse(trimmedLine));
    } catch {
      // Skip non-JSON lines (verbose mode may produce text)
    }
  }

  if (parsed.length === 0) {
    // Fallback: try legacy single-JSON parsing for backwards compatibility
    const trimmed = raw.trim();
    try {
      const data = JSON.parse(trimmed);
      if (onInvocation) onInvocation(data);
      return extractResult(data);
    } catch {
      throw new Error("No JSON found in Claude output");
    }
  }

  // Send all parsed objects to onInvocation as an array
  if (onInvocation) onInvocation(parsed);

  // Find the last "result" type object
  const resultObj = [...parsed].reverse().find((obj) => obj.type === "result");
  if (resultObj) {
    return extractResult(resultObj);
  }

  // No result object found — try using the last object
  const lastObj = parsed[parsed.length - 1];
  return extractResult(lastObj);
}

function extractResult(data: any): ClaudeResult {
  // Handle array format from --verbose mode
  if (Array.isArray(data)) {
    const resultEntry = data.find((item: any) => item.type === "result");
    if (resultEntry) {
      return extractResult(resultEntry);
    }
    // Fallback: join any text content
    const text = data.map((b: any) => b.text || "").join("");
    if (text) {
      return { result: text, sessionId: "", isError: false };
    }
    logger.warn({ responseData: data }, "extractResult: array response had no text content");
    return { result: "No readable response from Claude.", sessionId: "", isError: true };
  }

  // Helper to extract common metadata fields
  const sessionId = data.sessionid || data.session_id || "";
  const costUsd = data.totalcostusd || data.total_cost_usd || data.cost_usd;
  const duration = data.durationms || data.duration_ms;
  const isError = data.is_error || data.iserror || false;
  const subtype = data.subtype || data.stop_reason || data.stopreason || "";

  if (subtype.startsWith("error")) {
    // Catch-all for any error subtype (error_tool_use, error_*, etc.)
    const errorDetail = data.error || data.message || "";
    const friendlyDetail = errorDetail ? `: ${String(errorDetail).slice(0, 200)}` : "";
    logger.warn({ subtype, sessionId, errorDetail, responseKeys: Object.keys(data) }, "extractResult: error subtype response");
    return {
      result: `Claude encountered an error (${subtype})${friendlyDetail}. The task may be partially complete.`,
      sessionId,
      costUsd,
      duration,
      isError: true,
    };
  }

  // Handle single result object — prefer readable text
  const result = data.result || data.content;

  if (!result) {
    // No readable content — generate a friendly message based on what we know
    const typeInfo = subtype || data.type || "unknown";
    logger.warn({ subtype: typeInfo, sessionId, responseKeys: Object.keys(data) }, "extractResult: no result/content field in response");
    return {
      result: `Task completed but the response could not be parsed (type: ${typeInfo}). The task may still have been completed — check logs for details.`,
      sessionId,
      costUsd,
      duration,
      isError,
    };
  }

  // Extract text from result, handling both string and structured content block formats
  const resultText = extractText(result);

  if (!resultText) {
    logger.warn({ resultType: typeof result, sessionId, isArray: Array.isArray(result) }, "extractResult: result field present but no text could be extracted");
    return {
      result: "Task completed but the response contained no readable text. Check logs for details.",
      sessionId,
      costUsd,
      duration,
      isError,
    };
  }

  return {
    result: resultText,
    sessionId,
    costUsd,
    duration,
    isError,
  };
}

/** Extract readable text from a result field that may be a string, content block array, or other structure. */
function extractText(result: any): string {
  if (typeof result === "string") {
    return result;
  }

  // Handle array of content blocks: [{type: "text", text: "..."}, ...]
  if (Array.isArray(result)) {
    const texts = result
      .map((block: any) => {
        if (typeof block === "string") return block;
        if (block?.text) return String(block.text);
        if (block?.content) return String(block.content);
        return "";
      })
      .filter(Boolean);
    if (texts.length > 0) return texts.join("\n");
  }

  // Handle single object with text or content field
  if (result?.text) return String(result.text);
  if (result?.content) return String(result.content);
  if (result?.message) return String(result.message);

  // Could not extract readable text — don't fall back to JSON.stringify
  return "";
}
