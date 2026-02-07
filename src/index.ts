import { loadConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { createBot } from "./bot.js";
import { SessionManager } from "./claude/session-manager.js";
import { ProjectManager } from "./projects/project-manager.js";
import { InvocationLogger } from "./status/invocation-logger.js";
import { closeDatabase } from "./status/database.js";
import { startStatusServer } from "./status/server.js";
import { readFile } from "fs/promises";
import { join } from "path";
import { AgentConfigManager } from "./agents/agent-config.js";
import { BotConfigManager } from "./bot-config-manager.js";
import { agentRegistry } from "./agents/agent-registry.js";
import { ChatAgent } from "./agents/chat-agent.js";
import { Executor } from "./agents/executor.js";
import { PendingResponseManager } from "./pending-responses.js";
import { MemoryManager } from "./memory-manager.js";
import { CronManager } from "./cron-manager.js";
import { WebhookManager } from "./webhook-manager.js";
import { ActiveTaskTracker } from "./active-task-tracker.js";
import { TaskQueue } from "./task-queue.js";
import { setMessageBotApi } from "./handlers/message.js";

async function main() {
  const config = loadConfig();
  logger.info("Config loaded");

  const sessionManager = new SessionManager(config.dataDir);
  const projectManager = new ProjectManager(config.dataDir, config.defaultProjectDir);
  const invocationLogger = new InvocationLogger(config.dataDir);

  await sessionManager.load();
  await projectManager.load();
  await invocationLogger.load();

  const agentConfig = new AgentConfigManager(config.dataDir);
  await agentConfig.load();

  const botConfig = new BotConfigManager(config.dataDir);
  await botConfig.load();

  // Pending response recovery — load any unsent responses from disk
  const pendingResponses = new PendingResponseManager(config.dataDir);
  pendingResponses.load();

  // Memory manager — persistent per-user memory
  const memoryManager = new MemoryManager(config.dataDir);
  await memoryManager.load();

  // Cron manager — scheduled tasks
  const cronManager = new CronManager(config.dataDir);
  await cronManager.load();

  // Webhook manager — external triggers
  const webhookManager = new WebhookManager(config.dataDir);
  await webhookManager.load();

  // Active task tracker — crash recovery for interrupted executor tasks
  const activeTaskTracker = new ActiveTaskTracker(config.dataDir);
  activeTaskTracker.load();

  // Task queue — per-chat task queuing with persistent storage
  const taskQueue = new TaskQueue(config.dataDir);
  taskQueue.load();

  // Load personality for chat agent
  const personalityMd = await readFile(join(process.cwd(), "docs/personality.md"), "utf-8");

  // Create agents (uses singleton agentRegistry from agent-registry module)
  const chatAgent = new ChatAgent(config, agentConfig, sessionManager, personalityMd);
  const executor = new Executor(config, agentConfig, agentRegistry);

  // Attach task tracker to executor for crash recovery
  executor.setTaskTracker(activeTaskTracker);

  const bot = createBot(
    config, sessionManager, projectManager, invocationLogger,
    chatAgent, executor, agentConfig,
    pendingResponses, memoryManager, cronManager, webhookManager,
    activeTaskTracker, taskQueue,
  );

  // Set bot API reference for queue-initiated tasks in message handler
  setMessageBotApi(bot);

  // Wire cron trigger handler — runs work through the executor, sends results via Telegram
  cronManager.setTriggerHandler(async (job) => {
    logger.info({ jobId: job.id, chatId: job.chatId, task: job.task }, "Cron job executing");

    const projectDir = projectManager.getActiveProjectDir(job.chatId) || config.defaultProjectDir;

    try {
      await bot.api.sendMessage(job.chatId, `⏰ Running scheduled task: *${job.name}*`, { parse_mode: "Markdown" });

      const result = await executor.execute({
        chatId: job.chatId,
        task: job.task,
        context: `Triggered by cron schedule: ${job.schedule}`,
        complexity: "moderate",
        rawMessage: job.task,
        cwd: projectDir,
        onInvocation: (raw) => {
          const entry = Array.isArray(raw)
            ? raw.find((item: any) => item.type === "result") || raw[0]
            : raw;
          if (entry) {
            invocationLogger.log({
              timestamp: Date.now(),
              chatId: job.chatId,
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

      const icon = result.success ? "✅" : "❌";
      const msg = `${icon} Scheduled task *${job.name}* completed:\n\n${result.result}`;
      await bot.api.sendMessage(job.chatId, msg, { parse_mode: "Markdown" }).catch(async () => {
        await bot.api.sendMessage(job.chatId, `${icon} Scheduled task "${job.name}" completed:\n\n${result.result}`).catch(() => {});
      });

      job.lastSuccess = result.success;
      job.lastResult = result.result.slice(0, 500);
    } catch (err: any) {
      logger.error({ jobId: job.id, err }, "Cron job execution error");
      await bot.api.sendMessage(job.chatId, `❌ Scheduled task "${job.name}" failed: ${err.message}`).catch(() => {});
      throw err;
    }
  });

  // Wire webhook trigger handler — same pattern as cron
  webhookManager.setTriggerHandler(async (webhook, payload) => {
    logger.info({ webhookId: webhook.id, chatId: webhook.chatId, task: webhook.task }, "Webhook triggered");

    const projectDir = projectManager.getActiveProjectDir(webhook.chatId) || config.defaultProjectDir;

    try {
      await bot.api.sendMessage(webhook.chatId, `🔗 Webhook triggered: *${webhook.name}*`, { parse_mode: "Markdown" });

      const taskWithPayload = payload && Object.keys(payload).length > 0
        ? `${webhook.task}\n\nWebhook payload:\n${JSON.stringify(payload, null, 2)}`
        : webhook.task;

      const result = await executor.execute({
        chatId: webhook.chatId,
        task: taskWithPayload,
        context: `Triggered by webhook: ${webhook.name}`,
        complexity: "moderate",
        rawMessage: taskWithPayload,
        cwd: projectDir,
        onInvocation: (raw) => {
          const entry = Array.isArray(raw)
            ? raw.find((item: any) => item.type === "result") || raw[0]
            : raw;
          if (entry) {
            invocationLogger.log({
              timestamp: Date.now(),
              chatId: webhook.chatId,
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

      const icon = result.success ? "✅" : "❌";
      const msg = `${icon} Webhook *${webhook.name}* completed:\n\n${result.result}`;
      await bot.api.sendMessage(webhook.chatId, msg, { parse_mode: "Markdown" }).catch(async () => {
        await bot.api.sendMessage(webhook.chatId, `${icon} Webhook "${webhook.name}" completed:\n\n${result.result}`).catch(() => {});
      });

      webhook.lastSuccess = result.success;
      webhook.lastResult = result.result.slice(0, 500);
    } catch (err: any) {
      logger.error({ webhookId: webhook.id, err }, "Webhook trigger error");
      await bot.api.sendMessage(webhook.chatId, `❌ Webhook "${webhook.name}" failed: ${err.message}`).catch(() => {});
      throw err;
    }
  });

  // Start status page server
  const statusPort = parseInt(process.env.STATUS_PORT || "3069", 10);
  const statusServer = await startStatusServer(config.dataDir, statusPort, {
    adminJwtSecret: config.adminJwtSecret,
    agentConfig,
    agentRegistry,
    botConfigManager: botConfig,
    chatAgent,
    executor,
    sessionManager,
    invocationLogger,
    defaultProjectDir: config.defaultProjectDir,
    webhookManager,
  });

  const shutdown = async () => {
    logger.info("Shutting down...");
    cronManager.stopAll();
    await bot.stop();
    await statusServer.close();
    await sessionManager.save();
    await projectManager.save();
    await agentConfig.save();
    await botConfig.save();
    await memoryManager.save();
    await cronManager.save();
    await webhookManager.save();
    invocationLogger.close();
    closeDatabase();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("Starting bot...");
  await bot.start({
    onStart: async () => {
      logger.info("Bot is running");

      // Start cron jobs
      cronManager.startAll();

      // Recover any unsent responses from before the last restart
      if (pendingResponses.hasPending()) {
        const pending = pendingResponses.getAll();
        logger.info({ count: pending.length }, "Recovering unsent responses from before restart");
        for (const record of pending) {
          try {
            await bot.api.sendMessage(record.chatId, `🔄 [Recovered after restart]\n\n${record.responseText}`);
            pendingResponses.remove(record.id);
            logger.info({ id: record.id, chatId: record.chatId }, "Pending response delivered successfully");
          } catch (err) {
            logger.error({ err, id: record.id, chatId: record.chatId }, "Failed to deliver recovered response — will retry next restart");
          }
        }
      }

      // Detect interrupted tasks from crash — notify affected chats
      if (activeTaskTracker.hasInterrupted()) {
        const interrupted = activeTaskTracker.getAll();
        logger.warn({ count: interrupted.length }, "Detected interrupted tasks from previous run");

        // Group by chatId to send one message per chat
        const byChatId = new Map<number, typeof interrupted>();
        for (const task of interrupted) {
          const existing = byChatId.get(task.chatId) || [];
          existing.push(task);
          byChatId.set(task.chatId, existing);
        }

        for (const [chatId, tasks] of byChatId) {
          const lines = [`⚠️ *Crash Recovery*\n\nI was interrupted while working on ${tasks.length === 1 ? "a task" : `${tasks.length} tasks`}:\n`];
          for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            const sessionSnip = t.sessionId ? `\`${t.sessionId.slice(0, 12)}...\`` : "no session";
            lines.push(`${i + 1}. ${t.task.slice(0, 100)}`);
            lines.push(`   Session: ${sessionSnip}`);
          }
          lines.push("");
          lines.push("Use `/resume` to see details, `/resume <number>` to continue, or `/resume clear` to dismiss.");

          try {
            await bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
            logger.info({ chatId, taskCount: tasks.length }, "Sent crash recovery notification");
          } catch (err) {
            // Fallback without markdown
            try {
              await bot.api.sendMessage(chatId, lines.join("\n").replace(/[*`]/g, ""));
            } catch (err2) {
              logger.error({ err: err2, chatId }, "Failed to send crash recovery notification");
            }
          }
        }
        // Don't clear — leave tasks in tracker for /resume to use
      }

      // Detect queued tasks from before restart — notify but require manual confirmation
      if (taskQueue.hasQueued()) {
        const chatsWithQueued = taskQueue.getChatsWithQueued();
        logger.info({ chats: chatsWithQueued.length, total: taskQueue.getTotalCount() }, "Detected queued tasks from previous run");

        for (const chatId of chatsWithQueued) {
          const tasks = taskQueue.peek(chatId);
          const lines = [`📋 *Queued Tasks Recovered*\n\nFound ${tasks.length} queued task(s) from before restart:\n`];
          for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            lines.push(`${i + 1}. ${t.task.slice(0, 80)}`);
          }
          lines.push("");
          lines.push("Use `/queue` to view, `/resume queue` to process them, or `/queue clear` to discard.");

          try {
            await bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
            logger.info({ chatId, taskCount: tasks.length }, "Sent queue recovery notification");
          } catch (err) {
            try {
              await bot.api.sendMessage(chatId, lines.join("\n").replace(/[*`]/g, ""));
            } catch (err2) {
              logger.error({ err: err2, chatId }, "Failed to send queue recovery notification");
            }
          }
        }
        // Don't auto-process — wait for user to /resume queue
      }
    },
  });
}

main().catch((err) => {
  logger.fatal(err, "Fatal error");
  process.exit(1);
});
