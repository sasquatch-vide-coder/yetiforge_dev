import { Config } from "../config.js";
import { invokeClaude } from "../claude/invoker.js";
import { SessionManager } from "../claude/session-manager.js";
import { AgentConfigManager } from "./agent-config.js";
import { WorkerAgent } from "./worker.js";
import { AgentRegistry, agentRegistry as defaultRegistry } from "./agent-registry.js";
import { buildOrchestratorSystemPrompt } from "./prompts.js";
import type {
  WorkRequest,
  OrchestratorPlan,
  OrchestratorSummary,
  WorkerResult,
  StatusUpdate,
  WorkerTask,
} from "./types.js";
import { logger } from "../utils/logger.js";

const MAX_WORKERS = 10;
const STATUS_UPDATE_INTERVAL_MS = 5000; // Rate-limit status updates to 1 per 5s
const HEARTBEAT_INTERVAL_MS = 60000; // 60 seconds between heartbeats
const STALL_WARNING_MS = 120000; // 2 minutes of no output = stall warning
const STALL_KILL_MS = 300000; // 5 minutes of no output = kill the worker
const WORKER_TIMEOUT_MS = 300000; // 5 minutes max per worker
const ORCHESTRATION_TIMEOUT_MS = 3600000; // 60 minutes max for entire orchestration
const MAX_RESULT_CHARS = 8000; // 8KB result truncation for summary context
const MAX_RETRIES = 1; // Number of automatic retries for transient failures

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

export class Orchestrator {
  private workerAgent: WorkerAgent;
  private registry: AgentRegistry;

  // Active orchestration state for /kill and /retry support
  _activeRetryFn: ((workerNumber: number) => Promise<WorkerResult | null>) | null = null;
  _activeOrchId: string | null = null;

  constructor(
    private config: Config,
    private agentConfig: AgentConfigManager,
    private sessionManager: SessionManager,
    registry?: AgentRegistry,
  ) {
    this.workerAgent = new WorkerAgent(config, agentConfig);
    this.registry = registry || defaultRegistry;
  }

  getRegistry(): AgentRegistry {
    return this.registry;
  }

  async execute(opts: {
    chatId: number;
    workRequest: WorkRequest;
    cwd: string;
    abortSignal?: AbortSignal;
    onStatusUpdate?: (update: StatusUpdate) => void;
    onInvocation?: (raw: any) => void;
  }): Promise<OrchestratorSummary> {
    const tierConfig = this.agentConfig.getConfig("orchestrator");
    const systemPrompt = buildOrchestratorSystemPrompt();
    const orchestrationStartTime = Date.now();

    logger.info({ chatId: opts.chatId, task: opts.workRequest.task }, "Orchestrator starting");

    // Register orchestrator in the agent registry
    const orchId = this.registry.register({
      role: "orchestrator",
      chatId: opts.chatId,
      description: opts.workRequest.task,
      phase: "planning",
    });

    // Orchestration-level timeout — prevents runaway cost
    const orchAbort = new AbortController();
    let orchTimedOut = false;
    const orchTimeout = setTimeout(() => {
      orchTimedOut = true;
      orchAbort.abort();
      logger.error({ chatId: opts.chatId, orchId, elapsed: Date.now() - orchestrationStartTime },
        "Orchestration timeout — aborting all work");
      opts.onStatusUpdate?.({
        type: "status",
        message: `⛔ Orchestration timed out after ${formatDuration(ORCHESTRATION_TIMEOUT_MS)}. Aborting remaining work.`,
        important: true,
      });
    }, ORCHESTRATION_TIMEOUT_MS);

    // Link main abort signal to our orchestration controller
    const onMainAbort = () => orchAbort.abort();
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        orchAbort.abort();
      } else {
        opts.abortSignal.addEventListener("abort", onMainAbort, { once: true });
      }
    }

    // Use orchAbort.signal for all downstream operations
    const effectiveSignal = orchAbort.signal;

    // Rate-limited status update sender
    let lastStatusTime = 0;
    const sendStatus = (update: StatusUpdate) => {
      const now = Date.now();
      if (now - lastStatusTime >= STATUS_UPDATE_INTERVAL_MS) {
        lastStatusTime = now;
        opts.onStatusUpdate?.(update);
      }
    };

    // Phase 1: Planning — ask the orchestrator to create a plan
    const planPrompt = [
      `Work request from user:`,
      `Task: ${opts.workRequest.task}`,
      `Context: ${opts.workRequest.context}`,
      `Urgency: ${opts.workRequest.urgency}`,
      ``,
      `Working directory: ${opts.cwd}`,
      ``,
      `Analyze this request and output a JSON plan.`,
    ].join("\n");

    sendStatus({ type: "status", message: "Planning the work..." });

    // Planning phase: always start fresh, no tools (pure planner), limited turns
    const planResult = await invokeClaude({
      prompt: planPrompt,
      cwd: opts.cwd,
      sessionId: undefined,
      abortSignal: effectiveSignal,
      config: this.config,
      onInvocation: opts.onInvocation,
      systemPrompt,
      model: tierConfig.model,
      maxTurnsOverride: 1,
      timeoutMsOverride: tierConfig.timeoutMs,
      allowedTools: "",
    });

    // Parse the plan
    let plan: OrchestratorPlan;
    try {
      plan = parsePlan(planResult.result);
    } catch (err: any) {
      logger.error({ err, raw: planResult.result }, "Failed to parse orchestrator plan");
      clearTimeout(orchTimeout);
      opts.abortSignal?.removeEventListener("abort", onMainAbort);
      this.registry.complete(orchId, false, planResult.costUsd);
      return {
        type: "summary",
        overallSuccess: false,
        summary: `Planning failed: ${err.message}. The orchestrator did not produce a valid plan.`,
        workerResults: [],
        totalCostUsd: planResult.costUsd || 0,
      };
    }

    // Enforce max workers cap
    if (plan.workers.length > MAX_WORKERS) {
      logger.warn(
        { requested: plan.workers.length, cap: MAX_WORKERS },
        "Worker count exceeds cap, truncating"
      );
      plan.workers = plan.workers.slice(0, MAX_WORKERS);
    }

    logger.info({
      chatId: opts.chatId,
      summary: plan.summary,
      workerCount: plan.workers.length,
      sequential: plan.sequential,
    }, "Orchestrator plan created");

    // Update orchestrator registry — plan created, moving to execution
    this.registry.update(orchId, {
      phase: "executing",
      progress: `0/${plan.workers.length} tasks`,
      description: `${opts.workRequest.task} — ${plan.summary}`,
    });

    // Send short plan breakdown to user
    const modeLabel = plan.sequential ? "Sequential" : "Parallel";
    const planBreakdown = [
      `📋 Plan: ${plan.summary}`,
      `⚙️ ${modeLabel} — ${plan.workers.length} workers`,
      ...plan.workers.map((w, i) => `${i + 1}. ${w.description}`),
    ].join("\n");

    // Force-send plan breakdown as a NEW message (user gets notification)
    opts.onStatusUpdate?.({
      type: "plan_breakdown",
      message: planBreakdown,
      progress: `0/${plan.workers.length} tasks`,
      important: true,
    });

    // Build plan context string for worker awareness
    const planContextForWorkers = [
      `## Overall Plan Context`,
      `Overall goal: ${opts.workRequest.task}`,
      `Plan summary: ${plan.summary}`,
      `Total workers: ${plan.workers.length} (${modeLabel.toLowerCase()} execution)`,
      ``,
      `### All tasks in this plan:`,
      ...plan.workers.map((w, i) => `${i + 1}. [${w.id}] ${w.description}`),
    ].join("\n");

    // Phase 2: Execute workers
    const workerResults: WorkerResult[] = [];
    let completedCount = 0;
    const totalWorkers = plan.workers.length;
    let failFastTriggered = false;

    // Helper: build context injection for a worker (prior results + plan context)
    const buildWorkerContextPrefix = (
      workerNumber: number,
      priorResults: WorkerResult[],
    ): string => {
      const parts: string[] = [planContextForWorkers];

      parts.push(`\nYou are Worker #${workerNumber} of ${totalWorkers}.`);

      if (priorResults.length > 0) {
        parts.push(`\n## Results from prior workers:`);
        for (const pr of priorResults) {
          const statusLabel = pr.success ? "SUCCESS" : "FAILED";
          const truncated = pr.result.length > MAX_RESULT_CHARS
            ? pr.result.slice(0, MAX_RESULT_CHARS) + `\n... (truncated, ${pr.result.length - MAX_RESULT_CHARS} chars omitted)`
            : pr.result;
          parts.push(`\n--- ${pr.taskId} [${statusLabel}] ---`);
          parts.push(truncated);
        }
        parts.push(`\nUse the above results to inform your work. Do not repeat work already done.`);
      }

      return parts.join("\n");
    };

    // Helper: run a single worker with heartbeat + stall detection + registry tracking + timeout
    const executeWithMonitoring = (task: WorkerTask, workerNumber: number): Promise<WorkerResult> => {
      return new Promise((resolve) => {
        const startTime = Date.now();
        let lastActivityTime = Date.now();
        let stallWarned = false;

        // Create a per-worker AbortController linked to the orchestration controller
        const workerAbort = new AbortController();

        // If orchestration signal aborts, abort this worker too
        const onOrchAbort = () => workerAbort.abort();
        if (effectiveSignal.aborted) {
          workerAbort.abort();
        } else {
          effectiveSignal.addEventListener("abort", onOrchAbort, { once: true });
        }

        // Register worker in registry
        const workerId = this.registry.register({
          role: "worker",
          chatId: opts.chatId,
          description: task.description,
          phase: "executing",
          parentId: orchId,
        });

        // Store the worker's AbortController in the registry for /kill support
        this.registry.setWorkerAbortController(orchId, workerId, {
          controller: workerAbort,
          taskPrompt: task.prompt,
          taskDescription: task.description,
          workerNumber,
        });

        // Per-worker timeout
        const workerTimeout = setTimeout(() => {
          logger.warn({ taskId: task.id, workerNumber, elapsed: Date.now() - startTime },
            "Worker timeout — killing worker");
          opts.onStatusUpdate?.({
            type: "status",
            message: `⏱️ Worker #${workerNumber} "${task.description}" timed out after ${formatDuration(WORKER_TIMEOUT_MS)} — killing`,
            important: true,
          });
          workerAbort.abort();
        }, WORKER_TIMEOUT_MS);

        // Heartbeat: every 60s, update the user that the worker is still running
        const heartbeat = setInterval(() => {
          const elapsed = Date.now() - startTime;
          const elapsedStr = formatDuration(elapsed);
          this.registry.update(workerId, { lastActivityAt: Date.now() });
          opts.onStatusUpdate?.({
            type: "status",
            message: `⏳ Worker "${task.description}" still running (${elapsedStr} elapsed)`,
            progress: `${completedCount}/${totalWorkers} tasks done`,
          });
        }, HEARTBEAT_INTERVAL_MS);

        // Stall detection: check every 30s if output has gone silent
        const stallCheck = setInterval(() => {
          const silentFor = Date.now() - lastActivityTime;

          // Stage 1: Warning at STALL_WARNING_MS
          if (silentFor >= STALL_WARNING_MS && !stallWarned) {
            stallWarned = true;
            const silentMin = Math.round(silentFor / 60000);
            opts.onStatusUpdate?.({
              type: "status",
              message: `⚠️ Worker "${task.description}" has been silent for ${silentMin} minutes — may be stalled`,
              progress: `${completedCount}/${totalWorkers} tasks done`,
            });
            logger.warn({ taskId: task.id, silentForMs: silentFor }, "Worker may be stalled");
          }

          // Stage 2: Kill at STALL_KILL_MS
          if (silentFor >= STALL_KILL_MS) {
            const silentMin = Math.round(silentFor / 60000);
            logger.error({ taskId: task.id, silentForMs: silentFor },
              "Worker stalled — killing after prolonged silence");
            opts.onStatusUpdate?.({
              type: "status",
              message: `💀 Worker "${task.description}" killed after ${silentMin} minutes of silence`,
              progress: `${completedCount}/${totalWorkers} tasks done`,
              important: true,
            });
            workerAbort.abort();
          }
        }, 30000);

        // Activity tracker
        const onActivity = () => {
          lastActivityTime = Date.now();
          this.registry.update(workerId, { lastActivityAt: Date.now() });
          if (stallWarned) {
            stallWarned = false;
            opts.onStatusUpdate?.({
              type: "status",
              message: `Worker "${task.description}" is active again`,
              progress: `${completedCount}/${totalWorkers} tasks done`,
            });
          }
        };

        // Output tracker
        const onOutput = (chunk: string) => {
          this.registry.addOutput(workerId, chunk);
        };

        const cleanup = () => {
          clearInterval(heartbeat);
          clearInterval(stallCheck);
          clearTimeout(workerTimeout);
          effectiveSignal.removeEventListener("abort", onOrchAbort);
        };

        this.workerAgent
          .execute({
            task,
            cwd: opts.cwd,
            abortSignal: workerAbort.signal,
            onInvocation: (raw: any) => {
              if (raw && typeof raw === 'object') {
                if (Array.isArray(raw)) {
                  const entry = raw.find((item: any) => item.type === 'result') || raw[0];
                  if (entry) entry._tier = 'worker';
                } else {
                  raw._tier = 'worker';
                }
              }
              opts.onInvocation?.(raw);
            },
            onActivity,
            onOutput,
          })
          .then((result) => {
            cleanup();
            this.registry.complete(workerId, result.success, result.costUsd);
            this.registry.removeWorkerAbortController(orchId, workerId);
            resolve(result);
          })
          .catch((err) => {
            cleanup();
            const wasKilled = workerAbort.signal.aborted && !effectiveSignal.aborted;
            const wasTimedOut = err.message?.includes("timed out");
            this.registry.complete(workerId, false);
            resolve({
              taskId: task.id,
              success: false,
              result: wasKilled
                ? "Worker killed by user"
                : wasTimedOut
                  ? `Worker timed out after ${formatDuration(WORKER_TIMEOUT_MS)}`
                  : `Worker error: ${err.message}`,
              duration: Date.now() - startTime,
            });
          });
      });
    };

    // Helper: execute a worker with automatic retry for transient failures
    const executeWithRetry = async (task: WorkerTask, workerNumber: number): Promise<WorkerResult> => {
      let result = await executeWithMonitoring(task, workerNumber);

      // If failed and it's a transient error, retry once
      if (!result.success && isTransientError(result.result)) {
        logger.info({ taskId: task.id, workerNumber, error: result.result },
          "Worker hit transient error — retrying (attempt 2)");
        opts.onStatusUpdate?.({
          type: "status",
          message: `🔄 Worker #${workerNumber} "${task.description}" hit transient error, retrying...`,
          progress: `${completedCount}/${totalWorkers} tasks done`,
          important: true,
        });

        // Brief delay before retry
        await new Promise((r) => setTimeout(r, 3000));

        // Retry with a new task ID
        const retryTask: WorkerTask = {
          ...task,
          id: `${task.id}-retry`,
        };
        result = await executeWithMonitoring(retryTask, workerNumber);

        if (result.success) {
          logger.info({ taskId: task.id, workerNumber }, "Worker retry succeeded");
          opts.onStatusUpdate?.({
            type: "status",
            message: `✅ Worker #${workerNumber} retry succeeded`,
          });
        }
      }

      return result;
    };

    // Retry method: re-run a specific worker by its worker number
    const retryWorker = async (workerNumber: number): Promise<WorkerResult | null> => {
      const workerInfo = this.registry.getWorkerByNumber(orchId, workerNumber);
      if (!workerInfo) return null;

      const task: WorkerTask = {
        id: `retry-${workerInfo.info.workerNumber}-${Date.now()}`,
        description: workerInfo.info.taskDescription,
        prompt: workerInfo.info.taskPrompt,
      };

      this.registry.removeWorkerAbortController(orchId, workerInfo.workerId);

      const result = await executeWithMonitoring(task, workerNumber);
      return result;
    };

    // Store retryWorker on the orchestrator instance for external access
    this._activeRetryFn = retryWorker;
    this._activeOrchId = orchId;

    if (plan.sequential) {
      // Run workers one at a time, passing results forward
      for (let idx = 0; idx < plan.workers.length; idx++) {
        const task = plan.workers[idx];
        const workerNumber = idx + 1;
        if (effectiveSignal.aborted || failFastTriggered) break;

        // Inject context from prior workers into this worker's prompt
        const contextPrefix = buildWorkerContextPrefix(workerNumber, workerResults);
        const augmentedTask: WorkerTask = {
          ...task,
          prompt: `${contextPrefix}\n\n---\n\n## Your specific task:\n${task.prompt}`,
        };

        sendStatus({
          type: "status",
          message: `Starting: ${task.description}`,
          progress: `${completedCount}/${totalWorkers} tasks done`,
        });

        const result = await executeWithRetry(augmentedTask, workerNumber);

        workerResults.push(result);
        completedCount++;

        // Update orchestrator progress in registry
        this.registry.update(orchId, { progress: `${completedCount}/${totalWorkers} tasks` });

        // Immediate per-worker completion update — new message so user gets notified
        const statusIcon = result.success ? "✅" : "❌";
        const durationStr = result.duration ? ` (${formatDuration(result.duration)})` : "";
        opts.onStatusUpdate?.({
          type: "worker_complete",
          message: `${statusIcon} Done: ${task.description}${durationStr} — ${completedCount}/${totalWorkers} done`,
          progress: `${completedCount}/${totalWorkers} tasks done`,
          important: true,
        });

        // Fail-fast: if a sequential worker fails, abort remaining workers
        if (!result.success) {
          failFastTriggered = true;
          const remaining = totalWorkers - completedCount;
          logger.warn({ taskId: task.id, workerNumber, remaining },
            "Sequential worker failed — aborting remaining workers (fail-fast)");
          opts.onStatusUpdate?.({
            type: "status",
            message: `⛔ Worker #${workerNumber} failed — skipping ${remaining} remaining worker(s)`,
            progress: `${completedCount}/${totalWorkers} tasks done`,
            important: true,
          });
        }
      }
    } else {
      // Run workers with dependency tracking
      const completed = new Set<string>();
      const resultMap = new Map<string, WorkerResult>();
      const remaining = new Set(plan.workers.map((w) => w.id));

      // Build a worker number lookup
      const workerNumberMap = new Map<string, number>();
      plan.workers.forEach((w, i) => workerNumberMap.set(w.id, i + 1));

      while (remaining.size > 0) {
        if (effectiveSignal.aborted || failFastTriggered) break;

        // Find tasks whose dependencies are all satisfied
        const ready = plan.workers.filter(
          (w) => remaining.has(w.id) && (w.dependsOn || []).every((dep) => completed.has(dep))
        );

        if (ready.length === 0) {
          // Deadlock — no tasks can proceed
          logger.error({ remaining: [...remaining] }, "Worker dependency deadlock");
          break;
        }

        // Announce starting workers
        const names = ready.map((t) => t.description).join(", ");
        sendStatus({
          type: "status",
          message: `Starting ${ready.length} worker(s): ${names}`,
          progress: `${completedCount}/${totalWorkers} tasks done`,
        });

        // Inject context from completed dependencies into each ready worker
        const augmentedTasks = ready.map((task) => {
          const workerNumber = workerNumberMap.get(task.id)!;
          // For parallel workers with dependencies, pass only the results they depend on
          const depResults = (task.dependsOn || [])
            .map((depId) => resultMap.get(depId))
            .filter((r): r is WorkerResult => r !== undefined);
          const contextPrefix = buildWorkerContextPrefix(workerNumber, depResults);
          return {
            ...task,
            prompt: `${contextPrefix}\n\n---\n\n## Your specific task:\n${task.prompt}`,
          } as WorkerTask;
        });

        // Run all ready tasks in parallel with monitoring + retry
        const results = await Promise.all(
          augmentedTasks.map((task, i) =>
            executeWithRetry(task, workerNumberMap.get(ready[i].id)!)
          )
        );

        let batchHadFailure = false;
        for (let i = 0; i < ready.length; i++) {
          const task = ready[i];
          const result = results[i];
          workerResults.push(result);
          resultMap.set(task.id, result);
          completed.add(task.id);
          remaining.delete(task.id);
          completedCount++;

          // Update orchestrator progress in registry
          this.registry.update(orchId, { progress: `${completedCount}/${totalWorkers} tasks` });

          // Immediate per-worker completion update — new message so user gets notified
          const statusIcon = result.success ? "✅" : "❌";
          const durationStr = result.duration ? ` (${formatDuration(result.duration)})` : "";
          opts.onStatusUpdate?.({
            type: "worker_complete",
            message: `${statusIcon} Done: ${task.description}${durationStr} — ${completedCount}/${totalWorkers} done`,
            progress: `${completedCount}/${totalWorkers} tasks done`,
            important: true,
          });

          if (!result.success) batchHadFailure = true;
        }

        // Fail-fast in parallel mode: if any worker in a batch fails and has dependents, abort
        if (batchHadFailure) {
          // Check if any remaining workers depend on a failed task
          const failedIds = new Set(
            results.filter((r) => !r.success).map((_, i) => ready[i].id)
          );
          const blockedWorkers = plan.workers.filter(
            (w) => remaining.has(w.id) && (w.dependsOn || []).some((dep) => failedIds.has(dep))
          );
          if (blockedWorkers.length > 0) {
            failFastTriggered = true;
            logger.warn({ failedIds: [...failedIds], blockedCount: blockedWorkers.length },
              "Parallel worker(s) failed — aborting dependent workers (fail-fast)");
            opts.onStatusUpdate?.({
              type: "status",
              message: `⛔ Worker failure — skipping ${blockedWorkers.length} dependent worker(s)`,
              progress: `${completedCount}/${totalWorkers} tasks done`,
              important: true,
            });
          }
        }
      }
    }

    // Clear orchestration timeout
    clearTimeout(orchTimeout);
    opts.abortSignal?.removeEventListener("abort", onMainAbort);

    // Phase 3: Summary — update registry to summarizing phase
    this.registry.update(orchId, { phase: "summarizing" });

    // Phase 3: Summary — feed results back to orchestrator
    const totalCostUsd =
      (planResult.costUsd || 0) +
      workerResults.reduce((sum, r) => sum + (r.costUsd || 0), 0);

    const summaryPrompt = [
      `All workers have completed. Here are the results:`,
      ``,
      ...workerResults.map((r) =>
        [
          `--- Worker: ${r.taskId} ---`,
          `Success: ${r.success}`,
          `Duration: ${r.duration ? Math.round(r.duration / 1000) + "s" : "unknown"}`,
          `Result: ${r.result.slice(0, MAX_RESULT_CHARS)}`,
          ``,
        ].join("\n")
      ),
      ``,
      orchTimedOut ? `⚠️ NOTE: The orchestration was aborted due to a timeout (${formatDuration(ORCHESTRATION_TIMEOUT_MS)}). Some workers may not have run.` : "",
      failFastTriggered ? `⚠️ NOTE: Remaining workers were skipped due to a prior worker failure (fail-fast).` : "",
      ``,
      `Total cost so far: $${totalCostUsd.toFixed(4)}`,
      ``,
      `Provide a concise summary of what was accomplished, any failures, and any follow-up needed.`,
      `Respond in plain text (not JSON).`,
    ].join("\n");

    sendStatus({ type: "status", message: "Summarizing results..." });

    let summaryText = `${completedCount}/${plan.workers.length} tasks completed.`;
    let summaryCost = 0;

    try {
      const summaryResult = await invokeClaude({
        prompt: summaryPrompt,
        cwd: opts.cwd,
        sessionId: undefined,
        abortSignal: opts.abortSignal, // Use original signal for summary (orch timeout already cleared)
        config: this.config,
        onInvocation: opts.onInvocation,
        systemPrompt: "You are a task orchestrator. Summarize the worker results concisely. No personality. Plain text only.",
        model: tierConfig.model,
        maxTurnsOverride: 1,
        timeoutMsOverride: 30000,
        allowedTools: "",
      });

      summaryText = summaryResult.result;
      summaryCost = summaryResult.costUsd || 0;
    } catch (err: any) {
      logger.error({ err }, "Orchestrator summary phase failed");
      const successes = workerResults.filter((r) => r.success).length;
      const failures = workerResults.filter((r) => !r.success).length;
      summaryText = `Completed ${successes} task(s) successfully${failures > 0 ? `, ${failures} failed` : ""}. Total cost: $${totalCostUsd.toFixed(4)}.`;
    }

    const overallSuccess = workerResults.length > 0 && workerResults.every((r) => r.success);
    const finalCost = totalCostUsd + summaryCost;

    // Mark orchestrator complete in registry
    this.registry.complete(orchId, overallSuccess, finalCost);

    // Clean up worker AbortControllers
    this.registry.clearWorkerAbortControllers(orchId);
    this._activeRetryFn = null;
    this._activeOrchId = null;

    logger.info({
      chatId: opts.chatId,
      overallSuccess,
      workerCount: workerResults.length,
      totalCostUsd: finalCost,
      orchTimedOut,
      failFastTriggered,
    }, "Orchestrator complete");

    return {
      type: "summary",
      overallSuccess,
      summary: summaryText,
      workerResults,
      totalCostUsd: finalCost,
    };
  }
}

function parsePlan(raw: string): OrchestratorPlan {
  let text = raw.trim();

  // Strategy 1: Try parsing the entire response as JSON (ideal case)
  try {
    const plan = JSON.parse(text) as OrchestratorPlan;
    return validatePlan(plan);
  } catch {
    // Not pure JSON — try extraction strategies
  }

  // Strategy 2: Strip markdown code fences (```json ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenceMatch) {
    try {
      const plan = JSON.parse(fenceMatch[1].trim()) as OrchestratorPlan;
      return validatePlan(plan);
    } catch {
      // Fenced content wasn't valid JSON
    }
  }

  // Strategy 3: Find JSON object containing "type":"plan" in mixed prose
  const planTypeIndex = text.indexOf('"type"');
  if (planTypeIndex !== -1) {
    let braceStart = text.lastIndexOf("{", planTypeIndex);
    if (braceStart !== -1) {
      let depth = 0;
      for (let i = braceStart; i < text.length; i++) {
        if (text[i] === "{") depth++;
        if (text[i] === "}") depth--;
        if (depth === 0) {
          const candidate = text.slice(braceStart, i + 1);
          try {
            const plan = JSON.parse(candidate) as OrchestratorPlan;
            return validatePlan(plan);
          } catch {
            break;
          }
        }
      }
    }
  }

  // Strategy 4: Last resort — find the largest JSON object in the text
  const lastClose = text.lastIndexOf("}");
  if (lastClose !== -1) {
    let depth = 0;
    let start = -1;
    for (let i = lastClose; i >= 0; i--) {
      if (text[i] === "}") depth++;
      if (text[i] === "{") depth--;
      if (depth === 0) {
        start = i;
        break;
      }
    }
    if (start !== -1) {
      const candidate = text.slice(start, lastClose + 1);
      try {
        const plan = JSON.parse(candidate) as OrchestratorPlan;
        return validatePlan(plan);
      } catch {
        // Last resort failed
      }
    }
  }

  throw new Error(
    `Could not extract JSON plan from orchestrator output. Raw output starts with: "${text.slice(0, 100)}..."`
  );
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

function validatePlan(plan: OrchestratorPlan): OrchestratorPlan {
  if (plan.type !== "plan" || !Array.isArray(plan.workers)) {
    throw new Error("Invalid plan: missing type or workers array");
  }

  for (const worker of plan.workers) {
    if (!worker.id || !worker.prompt) {
      throw new Error(`Invalid worker task: missing id or prompt`);
    }
  }

  return plan;
}
