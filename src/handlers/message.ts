import { Context } from "grammy";
import { spawn } from "child_process";
import { Config } from "../config.js";
import { SessionManager } from "../claude/session-manager.js";
import { ProjectManager } from "../projects/project-manager.js";
import { ChatLocks } from "../middleware/rate-limit.js";
import { InvocationLogger } from "../status/invocation-logger.js";
import { ChatAgent } from "../agents/chat-agent.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { PendingResponseManager } from "../pending-responses.js";
import { MemoryManager } from "../memory-manager.js";
import { startTypingIndicator, sendResponse, editMessage } from "../utils/telegram.js";
import { logger } from "../utils/logger.js";

// Module-level references so orchestrateInBackground can access them
let _pendingResponses: PendingResponseManager | null = null;
let _memoryManager: MemoryManager | null = null;

export async function handleMessage(
  ctx: Context,
  config: Config,
  sessionManager: SessionManager,
  projectManager: ProjectManager,
  chatLocks: ChatLocks,
  invocationLogger: InvocationLogger,
  chatAgent: ChatAgent,
  orchestrator: Orchestrator,
  pendingResponses?: PendingResponseManager,
  memoryManager?: MemoryManager,
): Promise<void> {
  if (pendingResponses) _pendingResponses = pendingResponses;
  if (memoryManager) _memoryManager = memoryManager;
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text;
  if (!chatId || !text) return;

  // Lock chat
  const controller = chatLocks.lock(chatId);
  const stopTyping = startTypingIndicator(ctx);

  try {
    // Get project directory
    const projectDir = projectManager.getActiveProjectDir(chatId) || config.defaultProjectDir;

    logger.info({ chatId, projectDir, promptLength: text.length }, "Processing message via three-tier pipeline");

    // Build memory context for this user
    const memoryContext = _memoryManager?.buildMemoryContext(chatId) ?? undefined;

    // Step 1: Chat Agent — decides if this is chat or work
    const chatResult = await chatAgent.invoke({
      chatId,
      prompt: text,
      cwd: projectDir,
      abortSignal: controller.signal,
      memoryContext,
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

    // Step 3: If work is needed, orchestrate in the BACKGROUND
    if (chatResult.workRequest) {
      logger.info({ chatId, task: chatResult.workRequest.task }, "Work request detected, starting background orchestration");

      orchestrateInBackground(
        chatId,
        chatResult.workRequest,
        projectDir,
        ctx,
        orchestrator,
        chatAgent,
        invocationLogger
      ).catch((err) => {
        logger.error({ chatId, err }, "Background orchestration failed");
        ctx.reply(`Background work failed: ${err.message}`).catch(() => {});
      });
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

/**
 * Runs orchestration in the background without blocking the message handler.
 */
async function orchestrateInBackground(
  chatId: number,
  workRequest: any,
  projectDir: string,
  ctx: Context,
  orchestrator: Orchestrator,
  chatAgent: ChatAgent,
  invocationLogger: InvocationLogger
): Promise<void> {
  try {
    // Send initial "working" message — this one gets edited in-place for heartbeats
    let workingMessageId: number | null = null;
    try {
      const msg = await ctx.reply("⏳ Working on your request...");
      workingMessageId = msg.message_id;
    } catch (err) {
      // If initial message fails, we'll fall back to new messages for everything
      logger.warn({ chatId, err }, "Failed to send initial working message — will use new messages for all updates");
    }

    // Rate-limit tracker for transient edits only
    let lastEditTime = 0;
    const EDIT_THROTTLE_MS = 5000;

    const summary = await orchestrator.execute({
      chatId,
      workRequest,
      cwd: projectDir,
      onStatusUpdate: async (update) => {
        if (update.important) {
          // Important updates → send as a NEW message so user gets a Telegram notification
          try {
            await ctx.reply(update.message);
          } catch {
            // Fallback: try without any formatting
            await ctx.reply(update.message.replace(/[*_`]/g, "")).catch(() => {});
          }
        } else {
          // Transient updates (heartbeats, "still running") → edit the working message in-place
          if (!workingMessageId) return;
          const now = Date.now();
          if (now - lastEditTime < EDIT_THROTTLE_MS) return; // throttle edits
          lastEditTime = now;
          const msg = update.progress ? `${update.message} (${update.progress})` : update.message;
          await editMessage(ctx, workingMessageId, `⏳ ${msg}`).catch(() => {});
        }
      },
      onInvocation: (raw) => {
        const entry = Array.isArray(raw)
          ? raw.find((item: any) => item.type === "result") || raw[0]
          : raw;
        if (entry) {
          invocationLogger.log({
            timestamp: Date.now(),
            chatId,
            tier: entry._tier || "orchestrator",
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

    // Get Tiffany-voiced summary (with memory context)
    const summaryPrompt = `Work has been completed. Here's a summary of what was done:\n\n${summary.summary}\n\nOverall success: ${summary.overallSuccess}\nTotal cost: $${summary.totalCostUsd.toFixed(4)}\n\nSummarize this for the user in your own words.`;

    const memoryContext = _memoryManager?.buildMemoryContext(chatId) ?? undefined;

    const finalResult = await chatAgent.invoke({
      chatId,
      prompt: summaryPrompt,
      cwd: projectDir,
      memoryContext,
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
          }).catch(() => {});
        }
      },
    });

    // Save any memory notes from the summary response
    if (finalResult.memoryNote && _memoryManager) {
      _memoryManager.addNote(chatId, finalResult.memoryNote, "auto");
    }

    // Persist response to disk BEFORE sending — survives process death
    const finalMsg = finalResult.chatResponse || summary.summary;
    const prefix = summary.overallSuccess ? "✅" : "❌";
    const fullMsg = `${prefix} ${finalMsg}`;

    let pendingId: string | null = null;
    if (_pendingResponses) {
      pendingId = _pendingResponses.add(chatId, fullMsg, summary.overallSuccess);
    }

    // Delete the working message (it's no longer needed) and send final result as NEW message
    if (workingMessageId) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, workingMessageId);
      } catch {
        // If delete fails, edit it to show completion instead
        await editMessage(ctx, workingMessageId, "✅ Done — see below").catch(() => {});
      }
    }

    // Always send final result as a NEW message so the user gets a notification
    await sendResponse(ctx, fullMsg);

    // Response delivered — remove from pending
    if (pendingId && _pendingResponses) {
      _pendingResponses.remove(pendingId);
    }

    // Check if a restart is needed after orchestration completes
    let shouldRestart = summary.needsRestart === true;

    if (!shouldRestart) {
      const textToCheck = [
        summary.summary,
        workRequest.task || "",
        ...summary.workerResults.map((w: any) => w.result),
      ].join(" ").toLowerCase();

      const mentionsRestart = textToCheck.includes("restart");
      const mentionsService = textToCheck.includes("tiffbot") || textToCheck.includes("service");
      if (mentionsRestart && mentionsService) {
        shouldRestart = true;
      }
    }

    if (shouldRestart) {
      logger.info({ chatId }, "Scheduling delayed tiffbot restart...");
      const restartProc = spawn("bash", ["-c", "sleep 3 && sudo systemctl restart tiffbot"], {
        detached: true,
        stdio: "ignore",
      });
      restartProc.unref();
    }

    logger.info({
      chatId,
      overallSuccess: summary.overallSuccess,
      workerCount: summary.workerResults.length,
      totalCostUsd: summary.totalCostUsd,
      restartScheduled: shouldRestart,
    }, "Background orchestration complete");
  } catch (err: any) {
    logger.error({ chatId, err }, "Background orchestration error");
    await ctx.reply(`Work failed: ${err.message}`).catch(() => {});
  }
}
