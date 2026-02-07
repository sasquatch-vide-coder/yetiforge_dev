import { Config } from "../config.js";
import { invokeClaude } from "../claude/invoker.js";
import { AgentConfigManager } from "./agent-config.js";
import { AgentRegistry, agentRegistry as defaultRegistry } from "./agent-registry.js";
import { buildExecutorSystemPrompt, buildPlannerSystemPrompt, buildPlannerRevisionPrompt } from "./prompts.js";
import type { ExecutorResult, ExecutionPhase, StatusUpdate, StreamEvent } from "./types.js";
import { ActiveTaskTracker } from "../active-task-tracker.js";
import { logger } from "../utils/logger.js";

const STATUS_UPDATE_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 60000;

// Default stall detection thresholds (used as fallback if config unavailable)
// Actual values are now read from AgentConfigManager at runtime
import {
  DEFAULT_STALL_WARNING,
  DEFAULT_STALL_KILL,
  DEFAULT_STALL_GRACE_MULTIPLIER,
} from "./agent-config.js";

const STALL_WARNING_BY_COMPLEXITY: Record<string, number> = {
  trivial: DEFAULT_STALL_WARNING.trivialMs,
  moderate: DEFAULT_STALL_WARNING.moderateMs,
  complex: DEFAULT_STALL_WARNING.complexMs,
};

const STALL_KILL_BY_COMPLEXITY: Record<string, number> = {
  trivial: DEFAULT_STALL_KILL.trivialMs,
  moderate: DEFAULT_STALL_KILL.moderateMs,
  complex: DEFAULT_STALL_KILL.complexMs,
};

const STALL_GRACE_MULTIPLIER = DEFAULT_STALL_GRACE_MULTIPLIER;

// Timeout per complexity level
const TIMEOUT_BY_COMPLEXITY: Record<string, number> = {
  trivial: 5 * 60_000,     // 5 minutes
  moderate: 15 * 60_000,   // 15 minutes
  complex: 45 * 60_000,    // 45 minutes
};

// Transient errors that warrant automatic retry
const TRANSIENT_ERROR_PATTERNS = [
  "rate limit",
  "429",
  "timed out",
  "timeout",
  "ECONNRESET",
  "ECONNREFUSED",
  "socket hang up",
  "network error",
  "overloaded",
  "503",
  "502",
];

function isTransientError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  if (minutes < 60) return remainingSec > 0 ? `${minutes}m ${remainingSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  return `${hours}h ${remainingMin}m`;
}

export class Executor {
  private registry: AgentRegistry;
  private taskTracker: ActiveTaskTracker | null = null;

  constructor(
    private config: Config,
    private agentConfig: AgentConfigManager,
    registry?: AgentRegistry,
  ) {
    this.registry = registry || defaultRegistry;
  }

  /** Attach the active task tracker for crash recovery. */
  setTaskTracker(tracker: ActiveTaskTracker): void {
    this.taskTracker = tracker;
  }

  getRegistry(): AgentRegistry {
    return this.registry;
  }

  async execute(opts: {
    chatId: number;
    task: string;
    context: string;
    complexity: string;
    rawMessage: string;
    memoryContext?: string;
    cwd: string;
    abortSignal?: AbortSignal;
    onStatusUpdate?: (update: StatusUpdate) => void;
    onStreamEvent?: (event: StreamEvent) => void;
    onInvocation?: (raw: any) => void;
  }): Promise<ExecutorResult> {
    const tierConfig = this.agentConfig.getConfig("executor");
    const systemPrompt = buildExecutorSystemPrompt();
    const startTime = Date.now();
    const complexity = opts.complexity || "moderate";

    const executionTimeout = TIMEOUT_BY_COMPLEXITY[complexity] ?? TIMEOUT_BY_COMPLEXITY.moderate;

    logger.info({
      chatId: opts.chatId,
      task: opts.task,
      complexity,
      timeoutMs: executionTimeout,
    }, "Executor starting");

    // Register in agent registry
    const agentId = this.registry.register({
      role: "executor",
      chatId: opts.chatId,
      description: opts.task,
      phase: "executing",
    });

    // Track active task to disk for crash recovery
    let activeTaskId: string | null = null;
    if (this.taskTracker) {
      activeTaskId = this.taskTracker.track({
        chatId: opts.chatId,
        sessionId: "", // Will be updated when invoker returns a session ID
        task: opts.task,
        complexity,
        cwd: opts.cwd,
      });
    }

    // Execution-level timeout
    const execAbort = new AbortController();
    let execTimedOut = false;
    const execTimeout = setTimeout(() => {
      execTimedOut = true;
      execAbort.abort();
      logger.error({
        chatId: opts.chatId,
        agentId,
        elapsed: Date.now() - startTime,
      }, "Executor timeout — aborting");
      opts.onStatusUpdate?.({
        type: "status",
        message: `Execution timed out after ${formatDuration(executionTimeout)}. Aborting.`,
        important: true,
      });
    }, executionTimeout);

    // Link main abort signal to our controller
    const onMainAbort = () => execAbort.abort();
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        execAbort.abort();
      } else {
        opts.abortSignal.addEventListener("abort", onMainAbort, { once: true });
      }
    }

    const effectiveSignal = execAbort.signal;

    // Rate-limited status update sender
    let lastStatusTime = 0;
    const sendStatus = (update: StatusUpdate) => {
      const now = Date.now();
      if (now - lastStatusTime >= STATUS_UPDATE_INTERVAL_MS) {
        lastStatusTime = now;
        opts.onStatusUpdate?.(update);
      }
    };

    // Heartbeat + stall detection (complexity-aware)
    let lastActivityTime = Date.now();
    let stallWarned = false;
    let stallGraceActive = false;

    // Read stall thresholds from runtime config (admin-configurable)
    const cfgWarning = this.agentConfig.getStallWarning("executor");
    const cfgKill = this.agentConfig.getStallKill("executor");
    const cfgGrace = this.agentConfig.getStallGraceMultiplier("executor");

    const stallWarningMap: Record<string, number> = {
      trivial: cfgWarning.trivialMs,
      moderate: cfgWarning.moderateMs,
      complex: cfgWarning.complexMs,
    };
    const stallKillMap: Record<string, number> = {
      trivial: cfgKill.trivialMs,
      moderate: cfgKill.moderateMs,
      complex: cfgKill.complexMs,
    };

    const stallWarnThreshold = stallWarningMap[complexity] ?? stallWarningMap.moderate;
    const stallKillThreshold = stallKillMap[complexity] ?? stallKillMap.moderate;
    const stallHardKillThreshold = stallKillThreshold * cfgGrace;

    const heartbeat = setInterval(() => {
      const elapsed = Date.now() - startTime;
      this.registry.update(agentId, { lastActivityAt: Date.now() });
      opts.onStatusUpdate?.({
        type: "status",
        message: `Still working (${formatDuration(elapsed)} elapsed)`,
      });
    }, HEARTBEAT_INTERVAL_MS);

    const stallCheck = setInterval(() => {
      const silentFor = Date.now() - lastActivityTime;

      if (silentFor >= stallWarnThreshold && !stallWarned) {
        stallWarned = true;
        const silentMin = Math.round(silentFor / 60000);
        opts.onStatusUpdate?.({
          type: "status",
          message: `Executor has been silent for ${silentMin} minutes — may be stalled`,
        });
        logger.warn({ agentId, silentForMs: silentFor, complexity }, "Executor may be stalled");
      }

      if (silentFor >= stallKillThreshold && !stallGraceActive) {
        stallGraceActive = true;
        const silentMin = Math.round(silentFor / 60000);
        const graceSeconds = Math.round((stallHardKillThreshold - stallKillThreshold) / 1000);
        logger.warn({ agentId, silentForMs: silentFor, graceSeconds, complexity },
          "Executor hit stall kill threshold — grace period started");
        opts.onStatusUpdate?.({
          type: "status",
          message: `Executor silent for ${silentMin} minutes — grace period of ${graceSeconds}s before abort`,
          important: true,
        });
      }

      if (silentFor >= stallHardKillThreshold) {
        const silentMin = Math.round(silentFor / 60000);
        logger.error({ agentId, silentForMs: silentFor, complexity },
          "Executor stalled — killing after grace period expired");
        opts.onStatusUpdate?.({
          type: "status",
          message: `Executor killed after ${silentMin} minutes of silence (grace period expired)`,
          important: true,
        });
        execAbort.abort();
      }
    }, 30000);

    const onActivity = () => {
      lastActivityTime = Date.now();
      this.registry.update(agentId, { lastActivityAt: Date.now() });
      if (stallWarned || stallGraceActive) {
        stallWarned = false;
        stallGraceActive = false;
        sendStatus({
          type: "status",
          message: "Executor is active again",
        });
      }
    };

    const emitStreamEvent = (event: StreamEvent) => {
      opts.onStreamEvent?.(event);
    };

    // Buffer for incomplete NDJSON lines across chunks
    let ndjsonBuffer = "";

    const onOutput = (chunk: string) => {
      this.registry.addOutput(agentId, chunk);

      // Parse NDJSON stream: each line is a JSON object from --output-format stream-json
      ndjsonBuffer += chunk;
      const lines = ndjsonBuffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer
      ndjsonBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || !trimmedLine.startsWith("{")) continue;

        let obj: any;
        try {
          obj = JSON.parse(trimmedLine);
        } catch {
          continue; // Skip non-JSON lines
        }

        // We care about "assistant" type messages with tool_use content blocks
        // stream-json format nests content inside obj.message.content (not obj.content)
        const contentArray = obj.type === "assistant"
          ? (Array.isArray(obj.content) ? obj.content
             : obj.message && Array.isArray(obj.message.content) ? obj.message.content
             : null)
          : null;

        if (contentArray) {
          for (const block of contentArray) {
            if (block.type !== "tool_use" || !block.name) continue;

            const toolName = block.name;
            const input = block.input || {};

            switch (toolName) {
              case "Read": {
                const path = input.file_path || input.path || "";
                if (path) {
                  emitStreamEvent({ type: "file_read", timestamp: Date.now(), detail: path });
                  sendStatus({ type: "status", message: `Reading ${path.slice(0, 60)}` });
                }
                break;
              }
              case "Edit": {
                const path = input.file_path || input.path || "";
                if (path) {
                  emitStreamEvent({ type: "file_edit", timestamp: Date.now(), detail: path });
                  sendStatus({ type: "status", message: `Editing ${path.slice(0, 60)}` });
                }
                break;
              }
              case "Write": {
                const path = input.file_path || input.path || "";
                if (path) {
                  emitStreamEvent({ type: "file_write", timestamp: Date.now(), detail: path });
                  sendStatus({ type: "status", message: `Writing ${path.slice(0, 60)}` });
                }
                break;
              }
              case "Bash": {
                const cmd = (input.command || "").slice(0, 80);
                if (cmd) {
                  emitStreamEvent({ type: "command", timestamp: Date.now(), detail: cmd });
                  sendStatus({ type: "status", message: cmd });
                }
                break;
              }
              case "Glob":
              case "Grep": {
                const pattern = input.pattern || input.glob || "";
                if (pattern) {
                  emitStreamEvent({ type: "command", timestamp: Date.now(), detail: `${toolName}: ${pattern.slice(0, 70)}` });
                }
                break;
              }
              default:
                // Other tools — emit as info
                emitStreamEvent({ type: "info", timestamp: Date.now(), detail: `Tool: ${toolName}` });
                break;
            }
          }
        }
        // Also handle tool_result type for error detection
        else if (obj.type === "tool_result" && obj.is_error) {
          const errText = (typeof obj.content === "string" ? obj.content : "").slice(0, 100);
          emitStreamEvent({ type: "error", timestamp: Date.now(), detail: `Tool error: ${errText}` });
        }
      }
    };

    const cleanup = () => {
      clearInterval(heartbeat);
      clearInterval(stallCheck);
      clearTimeout(execTimeout);
      opts.abortSignal?.removeEventListener("abort", onMainAbort);
    };

    // Build the full prompt with all available context
    const promptParts: string[] = [];

    if (opts.memoryContext) {
      promptParts.push(`[MEMORY CONTEXT]\n${opts.memoryContext}\n`);
    }

    promptParts.push(`## Task\n${opts.task}`);

    if (opts.context) {
      promptParts.push(`\n## Context\n${opts.context}`);
    }

    promptParts.push(`\n## Original User Message\n${opts.rawMessage}`);
    promptParts.push(`\n## Working Directory\n${opts.cwd}`);

    const fullPrompt = promptParts.join("\n");

    // Execute with retry for transient errors
    let result: ExecutorResult;
    try {
      result = await this.invokeWithRetry({
        prompt: fullPrompt,
        cwd: opts.cwd,
        systemPrompt,
        model: tierConfig.model,
        abortSignal: effectiveSignal,
        onInvocation: (raw: any) => {
          if (raw && typeof raw === "object") {
            if (Array.isArray(raw)) {
              const entry = raw.find((item: any) => item.type === "result") || raw[0];
              if (entry) entry._tier = "executor";
              // Capture session ID for crash recovery
              const resultEntry = raw.find((item: any) => item.type === "result");
              const sid = resultEntry?.sessionid || resultEntry?.session_id;
              if (sid && activeTaskId && this.taskTracker) {
                this.taskTracker.updateSessionId(activeTaskId, sid);
              }
            } else {
              raw._tier = "executor";
              // Capture session ID for crash recovery
              const sid = raw.sessionid || raw.session_id;
              if (sid && activeTaskId && this.taskTracker) {
                this.taskTracker.updateSessionId(activeTaskId, sid);
              }
            }
          }
          opts.onInvocation?.(raw);
        },
        onActivity,
        onOutput,
        sendStatus,
      });
    } catch (err: any) {
      cleanup();
      const durationMs = Date.now() - startTime;

      this.registry.complete(agentId, false);

      // Remove from active task tracker (task failed, no resume needed)
      if (activeTaskId && this.taskTracker) {
        this.taskTracker.complete(activeTaskId);
      }

      logger.error({ agentId, err, durationMs }, "Executor failed");

      return {
        success: false,
        result: execTimedOut
          ? `Executor timed out after ${formatDuration(executionTimeout)}`
          : effectiveSignal.aborted
            ? "Executor was cancelled"
            : `Executor error: ${err.message}`,
        costUsd: 0,
        durationMs,
        needsRestart: false,
      };
    }

    cleanup();

    // Mark complete in registry
    this.registry.complete(agentId, result.success, result.costUsd);

    // Remove from active task tracker (task completed normally)
    if (activeTaskId && this.taskTracker) {
      this.taskTracker.complete(activeTaskId);
    }

    logger.info({
      chatId: opts.chatId,
      agentId,
      success: result.success,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
    }, "Executor complete");

    return result;
  }

  /**
   * Run the executor in PLAN mode — read-only investigation with restricted tools.
   * Returns the plan text (not an ExecutorResult) for presentation to the user.
   */
  async plan(opts: {
    chatId: number;
    task: string;
    context: string;
    complexity: string;
    rawMessage: string;
    memoryContext?: string;
    cwd: string;
    abortSignal?: AbortSignal;
    onStatusUpdate?: (update: StatusUpdate) => void;
    onStreamEvent?: (event: StreamEvent) => void;
    onInvocation?: (raw: any) => void;
    /** If revising, provide feedback and previous plan text */
    revisionFeedback?: string;
    previousPlan?: string;
  }): Promise<{ planText: string; costUsd: number; durationMs: number }> {
    const tierConfig = this.agentConfig.getConfig("executor");
    const startTime = Date.now();
    const complexity = opts.complexity || "moderate";

    // Use planner prompt (possibly with revision context)
    const systemPrompt = opts.revisionFeedback && opts.previousPlan
      ? buildPlannerRevisionPrompt(opts.revisionFeedback, opts.previousPlan)
      : buildPlannerSystemPrompt();

    // Restricted tools: read-only only
    const planTools = "Read,Grep,Glob,WebFetch,WebSearch,Task";

    // Shorter timeout for planning (half of execution timeout)
    const planTimeout = Math.min(
      (TIMEOUT_BY_COMPLEXITY[complexity] ?? TIMEOUT_BY_COMPLEXITY.moderate) / 2,
      10 * 60_000, // Cap at 10 minutes for planning
    );

    logger.info({
      chatId: opts.chatId,
      task: opts.task,
      complexity,
      phase: "plan",
      timeoutMs: planTimeout,
    }, "Executor starting in PLAN mode");

    // Register in agent registry
    const agentId = this.registry.register({
      role: "executor",
      chatId: opts.chatId,
      description: `[PLAN] ${opts.task}`,
      phase: "planning",
    });

    // Execution-level timeout
    const execAbort = new AbortController();
    let execTimedOut = false;
    const execTimeout = setTimeout(() => {
      execTimedOut = true;
      execAbort.abort();
      logger.error({ chatId: opts.chatId, agentId }, "Plan mode timeout — aborting");
      opts.onStatusUpdate?.({
        type: "status",
        message: `Planning timed out after ${formatDuration(planTimeout)}. Aborting.`,
        important: true,
      });
    }, planTimeout);

    // Link main abort signal
    const onMainAbort = () => execAbort.abort();
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        execAbort.abort();
      } else {
        opts.abortSignal.addEventListener("abort", onMainAbort, { once: true });
      }
    }

    const effectiveSignal = execAbort.signal;

    // Activity tracking
    let lastActivityTime = Date.now();
    const onActivity = () => {
      lastActivityTime = Date.now();
      this.registry.update(agentId, { lastActivityAt: Date.now() });
    };

    // NDJSON buffer for stream event parsing
    let ndjsonBuffer = "";
    const emitStreamEvent = (event: StreamEvent) => {
      opts.onStreamEvent?.(event);
    };

    const onOutput = (chunk: string) => {
      this.registry.addOutput(agentId, chunk);

      // Parse NDJSON for stream events (read-only tools only in plan mode)
      ndjsonBuffer += chunk;
      const lines = ndjsonBuffer.split("\n");
      ndjsonBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || !trimmedLine.startsWith("{")) continue;

        let obj: any;
        try { obj = JSON.parse(trimmedLine); } catch { continue; }

        const contentArray = obj.type === "assistant"
          ? (Array.isArray(obj.content) ? obj.content
             : obj.message && Array.isArray(obj.message.content) ? obj.message.content
             : null)
          : null;

        if (contentArray) {
          for (const block of contentArray) {
            if (block.type !== "tool_use" || !block.name) continue;
            const toolName = block.name;
            const input = block.input || {};

            switch (toolName) {
              case "Read": {
                const path = input.file_path || input.path || "";
                if (path) {
                  emitStreamEvent({ type: "file_read", timestamp: Date.now(), detail: path });
                }
                break;
              }
              case "Glob":
              case "Grep": {
                const pattern = input.pattern || input.glob || "";
                if (pattern) {
                  emitStreamEvent({ type: "command", timestamp: Date.now(), detail: `${toolName}: ${pattern.slice(0, 70)}` });
                }
                break;
              }
              default:
                emitStreamEvent({ type: "info", timestamp: Date.now(), detail: `Tool: ${toolName}` });
                break;
            }
          }
        }
      }
    };

    // Build prompt
    const promptParts: string[] = [];
    if (opts.memoryContext) {
      promptParts.push(`[MEMORY CONTEXT]\n${opts.memoryContext}\n`);
    }
    promptParts.push(`## Task\n${opts.task}`);
    if (opts.context) {
      promptParts.push(`\n## Context\n${opts.context}`);
    }
    promptParts.push(`\n## Original User Message\n${opts.rawMessage}`);
    promptParts.push(`\n## Working Directory\n${opts.cwd}`);

    const fullPrompt = promptParts.join("\n");

    try {
      const result = await invokeClaude({
        prompt: fullPrompt,
        cwd: opts.cwd,
        abortSignal: effectiveSignal,
        config: this.config,
        onInvocation: (raw: any) => {
          if (raw && typeof raw === "object") {
            if (Array.isArray(raw)) {
              const entry = raw.find((item: any) => item.type === "result") || raw[0];
              if (entry) entry._tier = "executor-plan";
            } else {
              raw._tier = "executor-plan";
            }
          }
          opts.onInvocation?.(raw);
        },
        systemPrompt,
        model: tierConfig.model,
        timeoutMsOverride: 0,
        allowedTools: planTools,
        onActivity,
        onOutput,
      });

      clearTimeout(execTimeout);
      opts.abortSignal?.removeEventListener("abort", onMainAbort);

      const durationMs = Date.now() - startTime;
      this.registry.complete(agentId, true, result.costUsd || 0);

      logger.info({
        chatId: opts.chatId,
        agentId,
        durationMs,
        costUsd: result.costUsd,
      }, "Plan mode complete");

      return {
        planText: result.result,
        costUsd: result.costUsd || 0,
        durationMs,
      };
    } catch (err: any) {
      clearTimeout(execTimeout);
      opts.abortSignal?.removeEventListener("abort", onMainAbort);

      const durationMs = Date.now() - startTime;
      this.registry.complete(agentId, false);

      logger.error({ agentId, err, durationMs }, "Plan mode failed");

      throw err;
    }
  }

  private async invokeWithRetry(opts: {
    prompt: string;
    cwd: string;
    systemPrompt: string;
    model: string;
    abortSignal: AbortSignal;
    onInvocation: (raw: any) => void;
    onActivity: () => void;
    onOutput: (chunk: string) => void;
    sendStatus: (update: StatusUpdate) => void;
  }): Promise<ExecutorResult> {
    const startTime = Date.now();

    try {
      const result = await invokeClaude({
        prompt: opts.prompt,
        cwd: opts.cwd,
        abortSignal: opts.abortSignal,
        config: this.config,
        onInvocation: opts.onInvocation,
        systemPrompt: opts.systemPrompt,
        model: opts.model,
        timeoutMsOverride: 0, // Managed by our own timeout
        onActivity: opts.onActivity,
        onOutput: opts.onOutput,
      });

      const durationMs = Date.now() - startTime;
      const needsRestart = detectRestartNeed(result.result);

      return {
        success: !result.isError,
        result: result.result,
        costUsd: result.costUsd || 0,
        durationMs,
        needsRestart,
      };
    } catch (err: any) {
      // Retry once for transient errors
      if (isTransientError(err.message)) {
        logger.info({ error: err.message }, "Executor hit transient error — retrying");
        opts.sendStatus({
          type: "status",
          message: "Hit transient error, retrying...",
          important: true,
        });

        await new Promise((r) => setTimeout(r, 3000));

        const result = await invokeClaude({
          prompt: opts.prompt,
          cwd: opts.cwd,
          abortSignal: opts.abortSignal,
          config: this.config,
          onInvocation: opts.onInvocation,
          systemPrompt: opts.systemPrompt,
          model: opts.model,
          timeoutMsOverride: 0,
          onActivity: opts.onActivity,
          onOutput: opts.onOutput,
        });

        const durationMs = Date.now() - startTime;
        const needsRestart = detectRestartNeed(result.result);

        return {
          success: !result.isError,
          result: result.result,
          costUsd: result.costUsd || 0,
          durationMs,
          needsRestart,
        };
      }

      throw err;
    }
  }
}

function detectRestartNeed(output: string): boolean {
  const lower = output.toLowerCase();
  const mentionsRestart = lower.includes("restart needed") ||
    lower.includes("service restart") ||
    lower.includes("restart tiffbot") ||
    lower.includes("note: service restart needed");
  return mentionsRestart;
}
