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
      "--output-format", "json",
      "--max-turns", String(config.maxTurns),
      "--verbose",
      "--dangerously-skip-permissions",
    ];

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
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Timeout
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Claude CLI timed out after ${config.claudeTimeoutMs}ms`));
    }, config.claudeTimeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);

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
        const parsed = parseClaudeOutput(stdout);
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
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function parseClaudeOutput(raw: string): ClaudeResult {
  // claude --output-format json outputs a JSON object
  // Find the last complete JSON object in the output (may have other output before it)
  const trimmed = raw.trim();

  // Try parsing the full output first
  try {
    const data = JSON.parse(trimmed);
    return extractResult(data);
  } catch {
    // Try to find JSON in the output
  }

  // Look for JSON object or array at the end (verbose mode may prepend text)
  const lastClose = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (lastClose === -1) throw new Error("No JSON found in Claude output");

  const closeChar = trimmed[lastClose];
  const openChar = closeChar === "}" ? "{" : "[";

  let depth = 0;
  let start = -1;
  for (let i = lastClose; i >= 0; i--) {
    if (trimmed[i] === closeChar) depth++;
    if (trimmed[i] === openChar) depth--;
    if (depth === 0) {
      start = i;
      break;
    }
  }

  if (start === -1) throw new Error("Malformed JSON in Claude output");

  const jsonStr = trimmed.slice(start, lastClose + 1);
  const data = JSON.parse(jsonStr);
  return extractResult(data);
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
    return { result: JSON.stringify(data), sessionId: "", isError: false };
  }

  // Handle single result object
  const result =
    data.result ||
    data.content ||
    JSON.stringify(data);

  return {
    result: typeof result === "string" ? result : JSON.stringify(result),
    sessionId: data.session_id || "",
    costUsd: data.total_cost_usd ?? data.cost_usd,
    duration: data.duration_ms,
    isError: data.is_error || false,
  };
}
