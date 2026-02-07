import { Context } from "grammy";
import { spawn } from "child_process";
import { Config } from "../config.js";
import { SessionManager } from "../claude/session-manager.js";
import { ProjectManager } from "../projects/project-manager.js";
import { ChatLocks } from "../middleware/rate-limit.js";
import { InvocationLogger } from "../status/invocation-logger.js";
import { ChatAgent } from "../agents/chat-agent.js";
import { Executor } from "../agents/executor.js";
import { PendingResponseManager } from "../pending-responses.js";
import { MemoryManager } from "../memory-manager.js";
import { TaskQueue } from "../task-queue.js";
import { PlanStore } from "../plan-store.js";
import { startTypingIndicator, sendResponse, editMessage, safeEditMessage } from "../utils/telegram.js";
import { StreamFormatter } from "../utils/stream-formatter.js";
import { logger } from "../utils/logger.js";
import type { WorkRequest, ChatAction } from "../agents/types.js";

// Module-level references so executeInBackground can access them
let _pendingResponses: PendingResponseManager | null = null;
let _memoryManager: MemoryManager | null = null;
let _taskQueue: TaskQueue | null = null;
let _chatLocks: ChatLocks | null = null;
let _config: Config | null = null;
let _chatAgent: ChatAgent | null = null;
let _executor: Executor | null = null;
let _invocationLogger: InvocationLogger | null = null;
let _bot: any = null; // Bot API for sending messages to chats without ctx

/** Singleton plan store — one pending plan per chat */
const _planStore = new PlanStore();

/** Set the bot API reference for queue-initiated tasks that don't have a ctx. */
export function setMessageBotApi(botApi: any): void {
  _bot = botApi;
}

/** Expose plan store for admin/debug endpoints */
export function getPlanStore(): PlanStore {
  return _planStore;
}

export async function handleMessage(
  ctx: Context,
  config: Config,
  sessionManager: SessionManager,
  projectManager: ProjectManager,
  chatLocks: ChatLocks,
  invocationLogger: InvocationLogger,
  chatAgent: ChatAgent,
  executor: Executor,
  pendingResponses?: PendingResponseManager,
  memoryManager?: MemoryManager,
  taskQueue?: TaskQueue,
): Promise<void> {
  if (pendingResponses) _pendingResponses = pendingResponses;
  if (memoryManager) _memoryManager = memoryManager;
  if (taskQueue) _taskQueue = taskQueue;
  if (!_chatLocks) _chatLocks = chatLocks;
  if (!_config) _config = config;
  if (!_chatAgent) _chatAgent = chatAgent;
  if (!_executor) _executor = executor;
  if (!_invocationLogger) _invocationLogger = invocationLogger;

  const chatId = ctx.chat?.id;
  const text = ctx.message?.text;
  if (!chatId || !text) return;

  // Lock chat
  const controller = chatLocks.lock(chatId);
  const stopTyping = startTypingIndicator(ctx);

  try {
    // Get project directory
    const projectDir = projectManager.getActiveProjectDir(chatId) || config.defaultProjectDir;

    logger.info({ chatId, projectDir, promptLength: text.length }, "Processing message via executor pipeline");

    // Build memory context for this user
    const memoryContext = _memoryManager?.buildMemoryContext(chatId) ?? undefined;

    // Check if there's a pending plan for this chat
    const pendingPlan = _planStore.get(chatId);
    const pendingPlanContext = pendingPlan ? pendingPlan.planText : undefined;

    // Step 1: Chat Agent — decides if this is chat, work, or plan response
    const chatResult = await chatAgent.invoke({
      chatId,
      prompt: text,
      cwd: projectDir,
      abortSignal: controller.signal,
      memoryContext,
      pendingPlanContext,
      onInvocation: (raw) => {
        const entry = Array.isArray(raw)
          ? raw.find((item: any) => item.type === "result") || raw[0]
          : raw;
        if (entry) {
          invocationLogger.log({
            timestamp: Date.now(),
            chatId,
            tier: "chat",
            durationMs: entry.durationms || entry.duration_ms,
            durationApiMs: entry.durationapims || entry.duration_api_ms,
            costUsd: entry.totalcostusd || entry.total_cost_usd || entry.cost_usd,
            numTurns: entry.numturns || entry.num_turns,
            stopReason: entry.subtype || entry.stopreason || entry.stop_reason,
            isError: entry.iserror || entry.is_error || false,
            modelUsage: entry.modelUsage || entry.model_usage,
          }).catch((err) => logger.error({ err }, "Failed to log chat invocation"));
        }
      },
    });

    // Save any auto-detected memory notes
    if (chatResult.memoryNote && _memoryManager) {
      _memoryManager.addNote(chatId, chatResult.memoryNote, "auto");
    }

    // Step 2: Send immediate chat response
    if (chatResult.chatResponse) {
      await sendResponse(ctx, chatResult.chatResponse);
    }

    // Save sessions
    await sessionManager.save();

    logger.info({ chatId, costUsd: chatResult.claudeResult.costUsd }, "Message processed");

    // Step 3: Handle the action (work request, plan approval, revision, or cancel)
    const action = chatResult.action;

    if (!action) {
      // No action — just chat. Done.
      return;
    }

    switch (action.type) {
      case "work_request":
        await handleWorkRequest(chatId, text, action as WorkRequest, projectDir, ctx, executor, chatAgent, invocationLogger, chatLocks, memoryContext);
        break;

      case "approve_plan":
        await handleApprovePlan(chatId, ctx, executor, chatAgent, invocationLogger, chatLocks);
        break;

      case "revise_plan":
        await handleRevisePlan(chatId, text, action.feedback, ctx, executor, chatAgent, invocationLogger, chatLocks);
        break;

      case "cancel_plan":
        handleCancelPlan(chatId, ctx);
        break;

      default:
        logger.warn({ chatId, action }, "Unknown action type from chat agent");
        break;
    }
  } catch (err: any) {
    if (err.message === "Cancelled") {
      logger.info({ chatId }, "Request cancelled");
      return;
    }

    logger.error({ chatId, err }, "Error handling message");

    const userMessage = err.message?.includes("Rate limited")
      ? "Claude is rate limited. Please wait a moment and try again."
      : err.message?.includes("timed out")
        ? "Request timed out. Try a simpler question or increase the timeout."
        : `Error: ${err.message}`;

    await ctx.reply(userMessage).catch(() => {});
  } finally {
    stopTyping();
    chatLocks.unlock(chatId);
  }
}

// ─── ACTION HANDLERS ───────────────────────────────────────────────────────────

/**
 * Handle a new work_request: start the planning phase.
 * Launches plan mode in the background, then stores the plan for approval.
 */
async function handleWorkRequest(
  chatId: number,
  rawMessage: string,
  workRequest: WorkRequest,
  projectDir: string,
  ctx: Context,
  executor: Executor,
  chatAgent: ChatAgent,
  invocationLogger: InvocationLogger,
  chatLocks: ChatLocks,
  memoryContext?: string,
): Promise<void> {
  if (chatLocks.isExecutorBusy(chatId)) {
    // Executor is busy — queue this task
    if (_taskQueue) {
      const queued = _taskQueue.enqueue({
        chatId,
        rawMessage,
        task: workRequest.task,
        context: workRequest.context || "",
        complexity: workRequest.complexity || "moderate",
        projectDir,
        memoryContext,
      });

      if (queued) {
        const position = _taskQueue.getQueueLength(chatId);
        await ctx.reply(`📋 Queued as #${position} — will auto-start when current task finishes.\nUse /queue to manage.`).catch(() => {});
        logger.info({ chatId, taskId: queued.id, position }, "Task queued (executor busy)");
      } else {
        await ctx.reply("⚠️ Queue is full (max 5 tasks). Wait for current work to finish or use /queue clear.").catch(() => {});
        logger.warn({ chatId }, "Task queue full — rejected");
      }
    } else {
      await ctx.reply("Still working on a previous task. Use /cancel to abort it.").catch(() => {});
    }
    return;
  }

  // Start planning phase in background
  logger.info({ chatId, task: workRequest.task, complexity: workRequest.complexity }, "Work request detected, starting PLAN phase");

  chatLocks.setExecutorBusy(chatId);
  planInBackground(
    chatId,
    rawMessage,
    workRequest,
    projectDir,
    ctx,
    executor,
    chatAgent,
    invocationLogger,
    chatLocks,
    memoryContext,
  ).catch((err) => {
    logger.error({ chatId, err }, "Plan phase failed");
    ctx.reply(`Planning failed: ${err.message}`).catch(() => {});
    chatLocks.setExecutorIdle(chatId);
  });
}

/**
 * Handle plan approval: consume the pending plan and start execution.
 */
async function handleApprovePlan(
  chatId: number,
  ctx: Context,
  executor: Executor,
  chatAgent: ChatAgent,
  invocationLogger: InvocationLogger,
  chatLocks: ChatLocks,
): Promise<void> {
  const plan = _planStore.consume(chatId);
  if (!plan) {
    // No pending plan — nothing to approve
    logger.warn({ chatId }, "approve_plan received but no pending plan exists");
    return;
  }

  if (chatLocks.isExecutorBusy(chatId)) {
    // Shouldn't happen, but handle gracefully
    await ctx.reply("⚠️ Executor is busy. Plan approval saved — will execute when free.").catch(() => {});
    // Re-store the plan so it doesn't get lost
    _planStore.set(chatId, plan);
    return;
  }

  logger.info({ chatId, task: plan.task }, "Plan approved — starting EXECUTE phase");

  chatLocks.setExecutorBusy(chatId);

  // Build enriched work request with the plan context baked in
  const workRequest = {
    task: plan.task,
    context: `${plan.context}\n\n## Approved Plan\n${plan.planText}`,
    complexity: plan.complexity,
  };

  executeInBackground(
    chatId,
    plan.rawMessage,
    workRequest,
    plan.projectDir,
    ctx,
    executor,
    chatAgent,
    invocationLogger,
    chatLocks,
    plan.memoryContext,
  ).catch((err) => {
    logger.error({ chatId, err }, "Execution after plan approval failed");
    ctx.reply(`Execution failed: ${err.message}`).catch(() => {});
    chatLocks.setExecutorIdle(chatId);
  });
}

/**
 * Handle plan revision: re-run planning with user feedback.
 */
async function handleRevisePlan(
  chatId: number,
  rawMessage: string,
  feedback: string,
  ctx: Context,
  executor: Executor,
  chatAgent: ChatAgent,
  invocationLogger: InvocationLogger,
  chatLocks: ChatLocks,
): Promise<void> {
  const plan = _planStore.get(chatId);
  if (!plan) {
    logger.warn({ chatId }, "revise_plan received but no pending plan exists");
    return;
  }

  if (chatLocks.isExecutorBusy(chatId)) {
    await ctx.reply("⚠️ Executor is busy. Try again when it's free.").catch(() => {});
    return;
  }

  logger.info({ chatId, task: plan.task, feedback, revisionCount: plan.revisionCount + 1 }, "Plan revision requested — re-planning");

  chatLocks.setExecutorBusy(chatId);

  // Re-run planning with revision context
  const revisionComplexity = (plan.complexity || "moderate") as "trivial" | "moderate" | "complex";
  planInBackground(
    chatId,
    plan.rawMessage,
    {
      task: plan.task,
      context: plan.context,
      complexity: revisionComplexity,
      type: "work_request",
      urgency: "normal",
    },
    plan.projectDir,
    ctx,
    executor,
    chatAgent,
    invocationLogger,
    chatLocks,
    plan.memoryContext,
    feedback,
    plan.planText,
    plan.revisionCount + 1,
  ).catch((err) => {
    logger.error({ chatId, err }, "Plan revision failed");
    ctx.reply(`Plan revision failed: ${err.message}`).catch(() => {});
    chatLocks.setExecutorIdle(chatId);
  });
}

/**
 * Handle plan cancellation: remove the pending plan.
 */
function handleCancelPlan(chatId: number, ctx: Context): void {
  const cancelled = _planStore.cancel(chatId);
  if (cancelled) {
    logger.info({ chatId }, "Plan cancelled by user");
  } else {
    logger.warn({ chatId }, "cancel_plan received but no pending plan exists");
  }
}

// ─── BACKGROUND EXECUTION ──────────────────────────────────────────────────────

/**
 * Runs the executor in PLAN mode (read-only) in the background.
 * On completion, stores the plan and presents it to the user for approval.
 */
async function planInBackground(
  chatId: number,
  rawMessage: string,
  workRequest: WorkRequest,
  projectDir: string,
  ctx: Context,
  executor: Executor,
  chatAgent: ChatAgent,
  invocationLogger: InvocationLogger,
  chatLocks: ChatLocks,
  memoryContext?: string,
  revisionFeedback?: string,
  previousPlan?: string,
  revisionCount: number = 0,
): Promise<void> {
  try {
    // Send initial "planning" message
    let workingMessageId: number | null = null;
    const planLabel = revisionCount > 0 ? `🔄 Re-planning (revision #${revisionCount})` : "📋 Planning";
    try {
      const msg = await ctx.reply(`${planLabel} — 0s\n\nInvestigating...`);
      workingMessageId = msg.message_id;
    } catch (err) {
      logger.warn({ chatId, err }, "Failed to send initial planning message");
    }

    // StreamFormatter for progress panel
    const formatter = new StreamFormatter(workRequest.task);
    const lastEditText = { value: "" };
    const planStartTime = Date.now();

    // Progress panel update interval
    const PANEL_UPDATE_INTERVAL_MS = 4000;
    let panelInterval: ReturnType<typeof setInterval> | null = null;

    if (workingMessageId) {
      panelInterval = setInterval(async () => {
        if (!workingMessageId) return;
        const panel = formatter.render();
        if (panel) {
          // Override the header to say "Planning" instead of "Working"
          const planPanel = panel.replace(/^⚙️ Working/, planLabel);
          await safeEditMessage(ctx, workingMessageId, planPanel, lastEditText).catch(() => {});
        }
      }, PANEL_UPDATE_INTERVAL_MS);
    }

    const planResult = await executor.plan({
      chatId,
      task: workRequest.task,
      context: workRequest.context || "",
      complexity: workRequest.complexity || "moderate",
      rawMessage,
      memoryContext,
      cwd: projectDir,
      revisionFeedback,
      previousPlan,
      onStreamEvent: (event) => {
        formatter.addEvent(event);
      },
      onInvocation: (raw) => {
        const entry = Array.isArray(raw)
          ? raw.find((item: any) => item.type === "result") || raw[0]
          : raw;
        if (entry) {
          invocationLogger.log({
            timestamp: Date.now(),
            chatId,
            tier: entry._tier || "executor-plan",
            durationMs: entry.durationms || entry.duration_ms,
            durationApiMs: entry.durationapims || entry.duration_api_ms,
            costUsd: entry.totalcostusd || entry.total_cost_usd || entry.cost_usd,
            numTurns: entry.numturns || entry.num_turns,
            stopReason: entry.subtype || entry.stopreason || entry.stop_reason,
            isError: entry.iserror || entry.is_error || false,
            modelUsage: entry.modelUsage || entry.model_usage,
          }).catch(() => {});
        }
      },
    });

    // Stop progress panel
    if (panelInterval) clearInterval(panelInterval);

    // Final panel render
    if (workingMessageId) {
      const elapsed = Math.round((Date.now() - planStartTime) / 1000);
      let finalPanel: string;
      if (formatter.eventCount > 0) {
        finalPanel = formatter.renderForce();
        finalPanel = finalPanel.replace(
          /^⚙️ Working — .+/,
          `📋 Plan Ready — ${elapsed}s`,
        );
      } else {
        finalPanel = `📋 Plan Ready — ${elapsed}s\n\nPlan investigation complete.`;
      }
      lastEditText.value = "";
      await safeEditMessage(ctx, workingMessageId, finalPanel, lastEditText).catch(() => {});
    }

    // Store the pending plan
    _planStore.set(chatId, {
      chatId,
      task: workRequest.task,
      context: workRequest.context || "",
      planText: planResult.planText,
      complexity: workRequest.complexity || "moderate",
      projectDir,
      rawMessage,
      memoryContext,
      createdAt: Date.now(),
      revisionCount,
    });

    // Present the plan directly via template (no voicing LLM call — saves tokens)
    const planDuration = Math.round(planResult.durationMs / 1000);
    const planCost = planResult.costUsd.toFixed(4);
    const planMessage = `📋 **Plan:**\n\n${planResult.planText}\n\n⏱ ${planDuration}s | 💰 $${planCost}\n\nApprove, request changes, or cancel?`;
    await sendResponse(ctx, planMessage);

    logger.info({
      chatId,
      costUsd: planResult.costUsd,
      durationMs: planResult.durationMs,
      revisionCount,
    }, "Plan presented to user, awaiting approval");
  } catch (err: any) {
    logger.error({ chatId, err }, "Plan background error");
    await ctx.reply(`Planning failed: ${err.message}`).catch(() => {});
  } finally {
    chatLocks.setExecutorIdle(chatId);
  }
}

/**
 * Runs executor in the background without blocking the message handler.
 * On completion, checks the task queue and auto-starts the next queued task.
 */
async function executeInBackground(
  chatId: number,
  rawMessage: string,
  workRequest: any,
  projectDir: string,
  ctx: Context,
  executor: Executor,
  chatAgent: ChatAgent,
  invocationLogger: InvocationLogger,
  chatLocks: ChatLocks,
  memoryContext?: string,
): Promise<void> {
  try {
    // Send initial "working" message — this one gets edited in-place with the progress panel
    let workingMessageId: number | null = null;
    try {
      const msg = await ctx.reply("\u2699\uFE0F Working \u2014 0s\n\nStarting up...");
      workingMessageId = msg.message_id;
    } catch (err) {
      logger.warn({ chatId, err }, "Failed to send initial working message");
    }

    // StreamFormatter for rich progress panel
    const formatter = new StreamFormatter(workRequest.task);
    const lastEditText = { value: "" };
    const execStartTime = Date.now();

    // Progress panel update interval (3-5 seconds)
    const PANEL_UPDATE_INTERVAL_MS = 4000;
    let panelInterval: ReturnType<typeof setInterval> | null = null;

    if (workingMessageId) {
      panelInterval = setInterval(async () => {
        if (!workingMessageId) return;
        const panel = formatter.render();
        if (panel) {
          await safeEditMessage(ctx, workingMessageId, panel, lastEditText).catch(() => {});
        }
      }, PANEL_UPDATE_INTERVAL_MS);
    }

    const result = await executor.execute({
      chatId,
      task: workRequest.task,
      context: workRequest.context || "",
      complexity: workRequest.complexity || "moderate",
      rawMessage,
      memoryContext,
      cwd: projectDir,
      onStreamEvent: (event) => {
        formatter.addEvent(event);
      },
      onStatusUpdate: async (update) => {
        if (update.important) {
          // Important updates -> new message (user gets notification)
          try {
            await ctx.reply(update.message);
          } catch {
            await ctx.reply(update.message.replace(/[*_`]/g, "")).catch(() => {});
          }
        }
        // Transient updates are now handled by the panel interval above
      },
      onInvocation: (raw) => {
        const entry = Array.isArray(raw)
          ? raw.find((item: any) => item.type === "result") || raw[0]
          : raw;
        if (entry) {
          invocationLogger.log({
            timestamp: Date.now(),
            chatId,
            tier: entry._tier || "executor",
            durationMs: entry.durationms || entry.duration_ms,
            durationApiMs: entry.durationapims || entry.duration_api_ms,
            costUsd: entry.totalcostusd || entry.total_cost_usd || entry.cost_usd,
            numTurns: entry.numturns || entry.num_turns,
            stopReason: entry.subtype || entry.stopreason || entry.stop_reason,
            isError: entry.iserror || entry.is_error || false,
            modelUsage: entry.modelUsage || entry.model_usage,
          }).catch(() => {});
        }
      },
    });

    // Stop the progress panel interval
    if (panelInterval) clearInterval(panelInterval);
    logger.info({ chatId, eventCount: formatter.eventCount, elapsedMs: Date.now() - execStartTime }, "Executor finished, rendering final panel");

    // Final panel render — mark as complete and preserve the message
    if (workingMessageId) {
      const elapsed = Math.round((Date.now() - execStartTime) / 1000);
      let finalPanel: string;
      if (formatter.eventCount > 0) {
        // Replace the "Working" header with a "Done" header in the final render
        // Use .+ (not \S+) to match multi-word elapsed times like "2m 30s" or "1h 20m"
        finalPanel = formatter.renderForce();
        finalPanel = finalPanel.replace(
          /^⚙️ Working — .+/,
          `✅ Done — ${elapsed}s`,
        );
      } else {
        finalPanel = `✅ Done — ${elapsed}s\n\nNo tool activity captured.`;
      }
      // Force the edit through by clearing lastEditText — ensures the "Done" panel
      // is always sent even if the only change is the header line
      lastEditText.value = "";
      logger.info({ chatId, messageId: workingMessageId, panelLength: finalPanel.length }, "Sending final Done panel");
      await safeEditMessage(ctx, workingMessageId, finalPanel, lastEditText).catch((err) => {
        logger.error({ chatId, err }, "Failed to send final Done panel");
      });
    }

    // Build final message directly via template (no voicing LLM call — saves tokens)
    const execDuration = Math.round(result.durationMs / 1000);
    const execCost = result.costUsd.toFixed(4);
    // Truncate result to ~500 chars for Telegram readability
    const truncatedResult = result.result.length > 500
      ? result.result.slice(0, 497) + "..."
      : result.result;
    const prefix = result.success ? "✅" : "❌";
    const fullMsg = `${prefix} **Done** (${execDuration}s, $${execCost})\n\n${truncatedResult}`;

    // Persist to disk BEFORE sending — survives process death
    let pendingId: string | null = null;
    if (_pendingResponses) {
      pendingId = _pendingResponses.add(chatId, fullMsg, result.success);
    }

    // Progress panel is preserved above — just send the final summary as a new message
    await sendResponse(ctx, fullMsg);

    // Response delivered — remove from pending
    if (pendingId && _pendingResponses) {
      _pendingResponses.remove(pendingId);
    }

    // Check if a restart is needed — ONLY trust the executor's explicit flag.
    // Previous heuristic text-matching ("restart" + "service"/"tiffbot") caused
    // false positives on tasks that merely discussed restarts without needing one.
    const shouldRestart = result.needsRestart;

    if (shouldRestart) {
      logger.info({ chatId }, "Scheduling delayed tiffbot restart (executor flagged needsRestart)...");
      const restartProc = spawn("bash", ["-c", "sleep 3 && sudo systemctl restart tiffbot"], {
        detached: true,
        stdio: "ignore",
      });
      restartProc.unref();
    }

    logger.info({
      chatId,
      success: result.success,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      restartScheduled: shouldRestart,
    }, "Background execution complete");
  } catch (err: any) {
    logger.error({ chatId, err }, "Background execution error");
    await ctx.reply(`Work failed: ${err.message}`).catch(() => {});
  } finally {
    // Mark executor as idle and process next queued task
    chatLocks.setExecutorIdle(chatId);
    processNextQueuedTask(chatId, chatLocks).catch((err) => {
      logger.error({ chatId, err }, "Error processing next queued task");
    });
  }
}

/**
 * Start processing the queue for a given chat. Called from /resume queue command
 * after restart to manually kick off queued task processing.
 */
export async function startQueueProcessing(chatId: number, chatLocks: ChatLocks): Promise<void> {
  if (!_taskQueue || !_executor || !_chatAgent || !_invocationLogger || !_bot) return;
  if (chatLocks.isExecutorBusy(chatId)) return; // Already busy
  if (_taskQueue.getQueueLength(chatId) === 0) return; // Nothing to process

  await processNextQueuedTask(chatId, chatLocks);
}

/**
 * Process the next queued task for a chat after the current one completes.
 * Uses the bot API directly since we don't have a message ctx for queued tasks.
 *
 * NOTE: Queued tasks go through the FULL plan→approval cycle too.
 * They start in plan mode and present the plan for approval.
 */
async function processNextQueuedTask(chatId: number, chatLocks: ChatLocks): Promise<void> {
  if (!_taskQueue || !_executor || !_chatAgent || !_invocationLogger || !_bot) return;

  const nextTask = _taskQueue.dequeue(chatId);
  if (!nextTask) return;

  const remaining = _taskQueue.getQueueLength(chatId);

  // Notify user that queued task is starting
  try {
    const queueInfo = remaining > 0 ? ` (${remaining} more in queue)` : "";
    await _bot.api.sendMessage(chatId, `🚀 Starting queued task${queueInfo}:\n${nextTask.task.slice(0, 100)}`);
  } catch (err) {
    logger.warn({ chatId, err }, "Failed to send queue start notification");
  }

  // Mark executor as busy again
  chatLocks.setExecutorBusy(chatId);

  // Create a minimal ctx-like object for sending messages
  const fakeCtx = {
    reply: async (text: string, opts?: any) => {
      return _bot.api.sendMessage(chatId, text, opts);
    },
    api: _bot.api,
    chat: { id: chatId },
  } as unknown as Context;

  const complexity = (nextTask.complexity || "moderate") as "trivial" | "moderate" | "complex";
  const workRequest: WorkRequest = {
    type: "work_request",
    task: nextTask.task,
    context: nextTask.context,
    complexity,
    urgency: "normal",
  };

  // Queued tasks go through the plan phase
  planInBackground(
    chatId,
    nextTask.rawMessage,
    workRequest,
    nextTask.projectDir,
    fakeCtx,
    _executor,
    _chatAgent,
    _invocationLogger,
    chatLocks,
    nextTask.memoryContext,
  ).catch((err) => {
    logger.error({ chatId, err }, "Queued task plan phase failed");
    _bot?.api.sendMessage(chatId, `Queued task planning failed: ${err.message}`).catch(() => {});
    chatLocks.setExecutorIdle(chatId);
  });
}
