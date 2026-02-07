import { Bot, Context } from "grammy";
import { Config } from "../config.js";
import { SessionManager } from "../claude/session-manager.js";
import { ProjectManager } from "../projects/project-manager.js";
import { ChatLocks } from "../middleware/rate-limit.js";
import { AgentConfigManager } from "../agents/agent-config.js";
import { invokeClaude } from "../claude/invoker.js";
import { startTypingIndicator, sendResponse } from "../utils/telegram.js";
import { logger } from "../utils/logger.js";
import { Executor } from "../agents/executor.js";
import { AgentRegistry } from "../agents/agent-registry.js";
import { MemoryManager } from "../memory-manager.js";
import { CronManager } from "../cron-manager.js";
import { WebhookManager } from "../webhook-manager.js";
import { ChatAgent } from "../agents/chat-agent.js";
import { ActiveTaskTracker } from "../active-task-tracker.js";
import { TaskQueue } from "../task-queue.js";
import { startQueueProcessing } from "./message.js";

export function registerCommands(
  bot: Bot,
  config: Config,
  sessionManager: SessionManager,
  projectManager: ProjectManager,
  chatLocks: ChatLocks,
  agentConfig: AgentConfigManager,
  executor?: Executor,
  registry?: AgentRegistry,
  memoryManager?: MemoryManager,
  cronManager?: CronManager,
  webhookManager?: WebhookManager,
  chatAgent?: ChatAgent,
  activeTaskTracker?: ActiveTaskTracker,
  taskQueue?: TaskQueue,
): void {
  bot.command("start", (ctx) => {
    ctx.reply(
      "TIFFBOT is ready. Send me a message and I'll pass it to Claude Code.\n\n" +
      "Commands:\n" +
      "/help - Show this help\n" +
      "/status - Current session info\n" +
      "/reset - Clear conversation session\n" +
      "/cancel - Abort current request\n" +
      "/queue - View/manage task queue\n" +
      "/resume - Resume interrupted tasks\n" +
      "/model - Show agent model config\n" +
      "/project - Manage projects\n" +
      "/git - Git operations\n" +
      "/memory - Manage persistent memory\n" +
      "/compact - Compact conversation context\n" +
      "/cron - Manage scheduled tasks\n" +
      "/webhook - Manage webhook triggers"
    );
  });

  bot.command("help", (ctx) => {
    ctx.reply(
      "*Commands:*\n" +
      "/status - Session & project info\n" +
      "/reset - Clear conversation context\n" +
      "/cancel - Abort current execution\n" +
      "/queue list|cancel|clear - Task queue management\n" +
      "/resume - Resume interrupted tasks\n" +
      "/model - Show agent model config\n" +
      "/project list|add|switch|remove - Manage projects\n" +
      "/git status|commit|push|pr - Git operations\n" +
      "/memory list|add|remove|clear - Persistent memory\n" +
      "/compact - Summarize & clear session\n" +
      "/cron list|add|remove|run|enable|disable - Scheduled tasks\n" +
      "/webhook list|create|remove - Webhook triggers\n\n" +
      "Just send a text message to chat with Claude.",
      { parse_mode: "Markdown" }
    );
  });

  bot.command("status", (ctx) => {
    const chatId = ctx.chat.id;
    const session = sessionManager.get(chatId);
    const projectName = projectManager.getActiveProjectName(chatId) || "(default)";
    const projectDir = projectManager.getActiveProjectDir(chatId) || config.defaultProjectDir;
    const isProcessing = chatLocks.isLocked(chatId);

    const lines = [
      `*Status:*`,
      `Project: ${projectName}`,
      `Directory: \`${projectDir}\``,
      `Session: ${session?.sessionId ? `\`${session.sessionId.slice(0, 8)}...\`` : "none"}`,
      `Processing: ${isProcessing ? "yes" : "no"}`,
    ];

    if (session?.lastUsedAt) {
      const ago = Math.round((Date.now() - session.lastUsedAt) / 60000);
      lines.push(`Last used: ${ago}m ago`);
    }

    // Add memory count
    if (memoryManager) {
      const notes = memoryManager.getNotes(chatId);
      lines.push(`Memory notes: ${notes.length}`);
    }

    // Add queue info
    if (taskQueue) {
      const qLen = taskQueue.getQueueLength(chatId);
      const execBusy = chatLocks.isExecutorBusy(chatId);
      lines.push(`Executor: ${execBusy ? "busy" : "idle"}`);
      if (qLen > 0) {
        lines.push(`Queue: ${qLen}/5 tasks`);
      }
    }

    // Add cron count
    if (cronManager) {
      const jobs = cronManager.getJobsForChat(chatId);
      const enabled = jobs.filter((j) => j.enabled).length;
      lines.push(`Cron jobs: ${enabled}/${jobs.length}`);
    }

    ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.command("reset", async (ctx) => {
    const chatId = ctx.chat.id;
    sessionManager.clear(chatId);
    await sessionManager.save();
    ctx.reply("Session cleared. Next message starts fresh.");
  });

  bot.command("cancel", (ctx) => {
    const chatId = ctx.chat.id;
    if (chatLocks.cancel(chatId)) {
      ctx.reply("Request cancelled.");
    } else {
      ctx.reply("Nothing to cancel.");
    }
  });

  // ── /queue command ──
  bot.command("queue", async (ctx) => {
    const chatId = ctx.chat.id;

    if (!taskQueue) {
      await ctx.reply("Task queue system is not available.");
      return;
    }

    const args = (ctx.match as string || "").trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    if (!subcommand || subcommand === "list") {
      const tasks = taskQueue.peek(chatId);
      const isBusy = chatLocks.isExecutorBusy(chatId);

      if (tasks.length === 0 && !isBusy) {
        await ctx.reply("No tasks queued and executor is idle.");
        return;
      }

      const lines: string[] = [];

      if (isBusy) {
        lines.push("⚙️ *Executor:* Currently busy\n");
      } else {
        lines.push("💤 *Executor:* Idle\n");
      }

      if (tasks.length === 0) {
        lines.push("Queue is empty.");
      } else {
        lines.push(`*Queued Tasks (${tasks.length}/5):*`);
        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i];
          const age = formatAge(t.queuedAt);
          lines.push(`${i + 1}. ${t.task.slice(0, 80)}`);
          lines.push(`   Complexity: ${t.complexity} | Queued: ${age} ago`);
        }
      }

      lines.push("");
      lines.push("Commands: `/queue cancel <number>` | `/queue clear`");
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }

    if (subcommand === "cancel") {
      const idx = parseInt(parts[1], 10);
      if (isNaN(idx) || idx < 1) {
        await ctx.reply("Usage: `/queue cancel <number>` (use `/queue list` to see numbers)", { parse_mode: "Markdown" });
        return;
      }

      const removed = taskQueue.cancelByPosition(chatId, idx);
      if (removed) {
        await ctx.reply(`🗑️ Removed queued task #${idx}: "${removed.task.slice(0, 60)}"`);
      } else {
        const queueLen = taskQueue.getQueueLength(chatId);
        if (queueLen === 0) {
          await ctx.reply("Queue is empty — nothing to cancel.");
        } else {
          await ctx.reply(`Invalid number. Queue has ${queueLen} task(s). Use \`/queue list\` to see them.`, { parse_mode: "Markdown" });
        }
      }
      return;
    }

    if (subcommand === "clear") {
      const count = taskQueue.clearChat(chatId);
      if (count > 0) {
        await ctx.reply(`🗑️ Cleared ${count} queued task(s).`);
      } else {
        await ctx.reply("Queue is already empty.");
      }
      return;
    }

    await ctx.reply("Usage: `/queue list|cancel|clear`", { parse_mode: "Markdown" });
  });

  // ── /resume command ──
  bot.command("resume", async (ctx) => {
    const chatId = ctx.chat.id;

    if (!activeTaskTracker) {
      await ctx.reply("Task recovery system is not available.");
      return;
    }

    const args = (ctx.match as string || "").trim();

    // Handle /resume queue — process queued tasks from before restart
    if (args === "queue") {
      if (!taskQueue) {
        await ctx.reply("Task queue system is not available.");
        return;
      }

      const qLen = taskQueue.getQueueLength(chatId);
      if (qLen === 0) {
        await ctx.reply("No queued tasks to resume.");
        return;
      }

      if (chatLocks.isExecutorBusy(chatId)) {
        await ctx.reply("Executor is already busy. Queued tasks will auto-start when it finishes.");
        return;
      }

      await ctx.reply(`🚀 Resuming ${qLen} queued task(s)...`);
      startQueueProcessing(chatId, chatLocks).catch((err) => {
        logger.error({ chatId, err }, "Error starting queue processing from /resume queue");
      });
      return;
    }

    const interrupted = activeTaskTracker.getForChat(chatId);
    if (interrupted.length === 0) {
      await ctx.reply("No interrupted tasks to resume. Use `/resume queue` to process queued tasks.", { parse_mode: "Markdown" });
      return;
    }

    if (args === "clear") {
      // Clear all interrupted tasks for this chat
      for (const task of interrupted) {
        activeTaskTracker.remove(task.id);
      }
      await ctx.reply(`Cleared ${interrupted.length} interrupted task(s).`);
      return;
    }

    if (args === "list" || !args) {
      // Show interrupted tasks
      const lines = [`*Interrupted Tasks (${interrupted.length}):*`];
      for (let i = 0; i < interrupted.length; i++) {
        const t = interrupted[i];
        const age = formatAge(t.startedAt);
        const sessionSnip = t.sessionId ? `\`${t.sessionId.slice(0, 12)}...\`` : "no session";
        lines.push(`${i + 1}. ${t.task.slice(0, 80)}`);
        lines.push(`   Session: ${sessionSnip}`);
        lines.push(`   Started: ${age} ago | Dir: \`${t.cwd}\``);
      }
      lines.push("");
      lines.push("Use `/resume <number>` to resume a task, or `/resume clear` to dismiss all.");
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }

    // Resume a specific task by number
    const idx = parseInt(args, 10);
    if (isNaN(idx) || idx < 1 || idx > interrupted.length) {
      await ctx.reply(`Invalid task number. Use 1-${interrupted.length}, or \`/resume list\` to see tasks.`, { parse_mode: "Markdown" });
      return;
    }

    const task = interrupted[idx - 1];

    if (!task.sessionId) {
      // No session ID — can't resume, just clear it
      activeTaskTracker.remove(task.id);
      await ctx.reply("That task has no session ID (crashed before Claude started). Removed from list.");
      return;
    }

    if (!executor) {
      await ctx.reply("Executor is not available.");
      return;
    }

    if (chatLocks.isLocked(chatId)) {
      await ctx.reply("Still processing a previous request. Use /cancel first.");
      return;
    }

    // Remove from tracker since we're about to re-execute
    activeTaskTracker.remove(task.id);

    const resumePrompt = `You are resuming an interrupted task. The previous session was interrupted (process crash/restart). Continue where you left off.\n\nOriginal task: ${task.task}\n\nPlease review what was done in the previous session and complete any remaining work.`;

    await ctx.reply(`🔄 Resuming interrupted task with session \`${task.sessionId.slice(0, 12)}...\``, { parse_mode: "Markdown" });

    const controller = chatLocks.lock(chatId);
    const stopTyping = startTypingIndicator(ctx);

    try {
      const result = await invokeClaude({
        prompt: resumePrompt,
        cwd: task.cwd,
        sessionId: task.sessionId,
        abortSignal: controller.signal,
        config,
        model: agentConfig.getConfig("executor").model,
        timeoutMsOverride: 0,
      });

      if (result.sessionId) {
        sessionManager.set(chatId, result.sessionId, task.cwd, "orchestrator");
        await sessionManager.save();
      }

      const icon = result.isError ? "❌" : "✅";
      await sendResponse(ctx, `${icon} Resumed task completed:\n\n${result.result}`);
    } catch (err: any) {
      if (err.message === "Cancelled") return;
      logger.error({ chatId, err, sessionId: task.sessionId }, "Error resuming task");
      await ctx.reply(`Error resuming task: ${err.message}`).catch(() => {});
    } finally {
      stopTyping();
      chatLocks.unlock(chatId);
    }
  });

  bot.command("model", (ctx) => {
    const cfg = agentConfig.getAll();
    const lines = [
      "*Agent Models:*",
      `Chat: \`${cfg.chat.model}\` (${cfg.chat.timeoutMs === 0 ? "no timeout" : cfg.chat.timeoutMs / 1000 + "s"})`,
      `Executor: \`${cfg.executor.model}\` (${cfg.executor.timeoutMs === 0 ? "no timeout" : cfg.executor.timeoutMs / 1000 + "s"})`,
    ];
    ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  // ── /memory command ──
  bot.command("memory", async (ctx) => {
    const chatId = ctx.chat.id;
    if (!memoryManager) {
      await ctx.reply("Memory system is not available.");
      return;
    }

    const args = (ctx.match as string || "").trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    if (!subcommand || subcommand === "list") {
      const notes = memoryManager.getNotes(chatId);
      if (notes.length === 0) {
        await ctx.reply("No memory notes saved. I'll learn about you as we chat, or use `/memory add <text>` to add one manually.", { parse_mode: "Markdown" });
        return;
      }

      const lines = [`*Memory Notes (${notes.length}):*`];
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        const age = formatAge(n.createdAt);
        const src = n.source === "auto" ? "🤖" : "📝";
        lines.push(`${i + 1}. ${src} ${n.text} _(${age})_`);
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }

    if (subcommand === "add") {
      const text = args.slice(4).trim();
      if (!text) {
        await ctx.reply("Usage: `/memory add <text>`", { parse_mode: "Markdown" });
        return;
      }
      memoryManager.addNote(chatId, text, "manual");
      await ctx.reply(`📝 Saved: "${text}"`);
      return;
    }

    if (subcommand === "remove") {
      const idx = parseInt(parts[1], 10);
      if (isNaN(idx) || idx < 1) {
        await ctx.reply("Usage: `/memory remove <number>` (use `/memory list` to see numbers)", { parse_mode: "Markdown" });
        return;
      }
      const notes = memoryManager.getNotes(chatId);
      if (idx > notes.length) {
        await ctx.reply(`Only ${notes.length} notes exist.`);
        return;
      }
      const note = notes[idx - 1];
      if (memoryManager.removeNote(chatId, note.id)) {
        await ctx.reply(`Removed note #${idx}: "${note.text}"`);
      } else {
        await ctx.reply("Failed to remove note.");
      }
      return;
    }

    if (subcommand === "clear") {
      memoryManager.clearNotes(chatId);
      await ctx.reply("All memory notes cleared.");
      return;
    }

    await ctx.reply("Usage: `/memory list|add|remove|clear`", { parse_mode: "Markdown" });
  });

  // ── /compact command ──
  bot.command("compact", async (ctx) => {
    const chatId = ctx.chat.id;

    if (!chatAgent || !memoryManager) {
      await ctx.reply("Compact is not available (missing dependencies).");
      return;
    }

    if (chatLocks.isLocked(chatId)) {
      await ctx.reply("Still processing a previous request. Use /cancel first.");
      return;
    }

    const controller = chatLocks.lock(chatId);
    const stopTyping = startTypingIndicator(ctx);

    try {
      const projectDir = projectManager.getActiveProjectDir(chatId) || config.defaultProjectDir;
      const memoryContext = memoryManager.buildMemoryContext(chatId) ?? undefined;

      // Ask chat agent to summarize the conversation and emit memory blocks
      const compactPrompt = `The user has requested a conversation compaction. Please:
1. Summarize the key points from our conversation so far in 2-3 sentences.
2. Save any important, durable facts you've learned as <TIFFBOT_MEMORY> blocks.
3. Let the user know the conversation context has been cleared but you'll remember the important bits.

Respond in your usual Tiffany voice.`;

      const result = await chatAgent.invoke({
        chatId,
        prompt: compactPrompt,
        cwd: projectDir,
        abortSignal: controller.signal,
        memoryContext,
      });

      // Save any memory notes from the compact response
      if (result.memoryNote && memoryManager) {
        memoryManager.addNote(chatId, result.memoryNote, "auto");
      }

      // Clear the chat session
      sessionManager.clear(chatId, "chat");
      await sessionManager.save();

      // Send the summary
      await sendResponse(ctx, result.chatResponse || "Session compacted. Memory saved.");

      logger.info({ chatId }, "Conversation compacted");
    } catch (err: any) {
      if (err.message === "Cancelled") return;
      logger.error({ chatId, err }, "Error during compact");
      await ctx.reply(`Error during compact: ${err.message}`).catch(() => {});
    } finally {
      stopTyping();
      chatLocks.unlock(chatId);
    }
  });

  // ── /cron command ──
  bot.command("cron", async (ctx) => {
    const chatId = ctx.chat.id;
    if (!cronManager) {
      await ctx.reply("Cron system is not available.");
      return;
    }

    const args = (ctx.match as string || "").trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    if (!subcommand || subcommand === "list") {
      const jobs = cronManager.getJobsForChat(chatId);
      if (jobs.length === 0) {
        await ctx.reply("No cron jobs. Use `/cron add \"<schedule>\" <task>` to create one.\n\nExample: `/cron add \"*/30 * * * *\" Check server health`", { parse_mode: "Markdown" });
        return;
      }

      const lines = [`*Cron Jobs (${jobs.length}):*`];
      for (const j of jobs) {
        const status = j.enabled ? "✅" : "⏸️";
        const lastRun = j.lastRunAt ? formatAge(j.lastRunAt) + " ago" : "never";
        const lastIcon = j.lastSuccess === true ? "✅" : j.lastSuccess === false ? "❌" : "—";
        lines.push(`${status} *${j.name}*`);
        lines.push(`  ID: \`${j.id}\``);
        lines.push(`  Schedule: \`${j.schedule}\``);
        lines.push(`  Task: ${j.task}`);
        lines.push(`  Last run: ${lastRun} ${lastIcon}`);
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }

    if (subcommand === "add") {
      // Parse: /cron add "*/5 * * * *" Task description here
      // Or: /cron add "name" "*/5 * * * *" Task description here
      const restOfArgs = args.slice(4).trim();

      // Match quoted schedule expression
      const scheduleMatch = restOfArgs.match(/^"([^"]+)"\s+(.*)/s);
      if (!scheduleMatch) {
        await ctx.reply('Usage: `/cron add "<schedule>" <task>`\n\nExample: `/cron add "*/30 * * * *" Check server health`', { parse_mode: "Markdown" });
        return;
      }

      const schedule = scheduleMatch[1];
      const task = scheduleMatch[2].trim();

      if (!task) {
        await ctx.reply("Please provide a task description after the schedule.");
        return;
      }

      // Use first few words of task as name
      const name = task.split(/\s+/).slice(0, 4).join(" ");

      const result = cronManager.addJob(chatId, name, schedule, task);
      if (typeof result === "string") {
        // Error message
        await ctx.reply(result);
        return;
      }

      await ctx.reply(
        `⏰ Cron job created!\n\n` +
        `*Name:* ${result.name}\n` +
        `*ID:* \`${result.id}\`\n` +
        `*Schedule:* \`${result.schedule}\`\n` +
        `*Task:* ${result.task}`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (subcommand === "remove") {
      const jobId = parts[1];
      if (!jobId) {
        await ctx.reply("Usage: `/cron remove <id>` (use `/cron list` to see IDs)", { parse_mode: "Markdown" });
        return;
      }

      // Allow removing by ID or by number
      const jobs = cronManager.getJobsForChat(chatId);
      const idx = parseInt(jobId, 10);
      let targetId = jobId;
      if (!isNaN(idx) && idx >= 1 && idx <= jobs.length) {
        targetId = jobs[idx - 1].id;
      }

      if (cronManager.removeJob(targetId)) {
        await ctx.reply("🗑️ Cron job removed.");
      } else {
        await ctx.reply("Cron job not found.");
      }
      return;
    }

    if (subcommand === "run") {
      const jobId = parts[1];
      if (!jobId) {
        await ctx.reply("Usage: `/cron run <id>` — triggers job immediately", { parse_mode: "Markdown" });
        return;
      }

      const jobs = cronManager.getJobsForChat(chatId);
      const idx = parseInt(jobId, 10);
      let targetId = jobId;
      if (!isNaN(idx) && idx >= 1 && idx <= jobs.length) {
        targetId = jobs[idx - 1].id;
      }

      const triggered = await cronManager.triggerNow(targetId);
      if (triggered) {
        await ctx.reply("🚀 Job triggered manually.");
      } else {
        await ctx.reply("Cron job not found.");
      }
      return;
    }

    if (subcommand === "enable") {
      const jobId = parts[1];
      if (!jobId) {
        await ctx.reply("Usage: `/cron enable <id>`", { parse_mode: "Markdown" });
        return;
      }
      if (cronManager.enableJob(jobId)) {
        await ctx.reply("✅ Cron job enabled.");
      } else {
        await ctx.reply("Cron job not found.");
      }
      return;
    }

    if (subcommand === "disable") {
      const jobId = parts[1];
      if (!jobId) {
        await ctx.reply("Usage: `/cron disable <id>`", { parse_mode: "Markdown" });
        return;
      }
      if (cronManager.disableJob(jobId)) {
        await ctx.reply("⏸️ Cron job disabled.");
      } else {
        await ctx.reply("Cron job not found.");
      }
      return;
    }

    await ctx.reply("Usage: `/cron list|add|remove|run|enable|disable`", { parse_mode: "Markdown" });
  });

  // ── /webhook command ──
  bot.command("webhook", async (ctx) => {
    const chatId = ctx.chat.id;
    if (!webhookManager) {
      await ctx.reply("Webhook system is not available.");
      return;
    }

    const args = (ctx.match as string || "").trim();
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    if (!subcommand || subcommand === "list") {
      const hooks = webhookManager.getWebhooksForChat(chatId);
      if (hooks.length === 0) {
        await ctx.reply("No webhooks configured. Use `/webhook create <name> | <task>` to create one.", { parse_mode: "Markdown" });
        return;
      }

      const lines = [`*Webhooks (${hooks.length}):*`];
      for (const h of hooks) {
        const status = h.enabled ? "✅" : "⏸️";
        const lastTrigger = h.lastTriggeredAt ? formatAge(h.lastTriggeredAt) + " ago" : "never";
        lines.push(`${status} *${h.name}*`);
        lines.push(`  ID: \`${h.id}\``);
        lines.push(`  Task: ${h.task}`);
        lines.push(`  Last triggered: ${lastTrigger}`);
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }

    if (subcommand === "create") {
      // Parse: /webhook create <name> | <task>
      const rest = args.slice(7).trim();
      const pipeIdx = rest.indexOf("|");

      if (pipeIdx === -1) {
        await ctx.reply('Usage: `/webhook create <name> | <task>`\n\nExample: `/webhook create Deploy Check | Check deploy status and report`', { parse_mode: "Markdown" });
        return;
      }

      const name = rest.slice(0, pipeIdx).trim();
      const task = rest.slice(pipeIdx + 1).trim();

      if (!name || !task) {
        await ctx.reply("Both name and task are required.");
        return;
      }

      const webhook = webhookManager.createWebhook(chatId, name, task);

      // Build the webhook URL
      const host = process.env.WEBHOOK_HOST || process.env.STATUS_HOST || "localhost:3069";
      const url = `https://${host}/api/webhooks/${webhook.id}/trigger`;

      await ctx.reply(
        `🔗 Webhook created!\n\n` +
        `*Name:* ${webhook.name}\n` +
        `*ID:* \`${webhook.id}\`\n` +
        `*Task:* ${webhook.task}\n\n` +
        `*URL:* \`${url}\`\n` +
        `*Secret:* \`${webhook.secret}\`\n\n` +
        `Use:\n\`\`\`\ncurl -X POST "${url}" -H "X-Webhook-Secret: ${webhook.secret}"\n\`\`\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (subcommand === "remove") {
      const hookId = parts[1];
      if (!hookId) {
        await ctx.reply("Usage: `/webhook remove <id>`", { parse_mode: "Markdown" });
        return;
      }

      if (webhookManager.removeWebhook(hookId)) {
        await ctx.reply("🗑️ Webhook removed.");
      } else {
        await ctx.reply("Webhook not found.");
      }
      return;
    }

    await ctx.reply("Usage: `/webhook list|create|remove`", { parse_mode: "Markdown" });
  });

  // /project command
  bot.command("project", async (ctx) => {
    const chatId = ctx.chat.id;
    const args = (ctx.match as string || "").trim().split(/\s+/);
    const subcommand = args[0]?.toLowerCase();

    if (!subcommand || subcommand === "list") {
      const projects = projectManager.list();
      const activeName = projectManager.getActiveProjectName(chatId);

      if (projects.size === 0) {
        ctx.reply("No projects configured. Use `/project add <name> <path>` to add one.", { parse_mode: "Markdown" });
        return;
      }

      const lines = ["*Projects:*"];
      for (const [name, path] of projects) {
        const marker = name === activeName ? " (active)" : "";
        lines.push(`\`${name}\`${marker} → \`${path}\``);
      }
      ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }

    if (subcommand === "add") {
      const name = args[1];
      const path = args.slice(2).join(" ");
      if (!name || !path) {
        ctx.reply("Usage: `/project add <name> <path>`", { parse_mode: "Markdown" });
        return;
      }
      projectManager.add(name, path);
      await projectManager.save();
      ctx.reply(`Project \`${name}\` added → \`${path}\``, { parse_mode: "Markdown" });
      return;
    }

    if (subcommand === "switch") {
      const name = args[1];
      if (!name) {
        ctx.reply("Usage: `/project switch <name>`", { parse_mode: "Markdown" });
        return;
      }
      const path = projectManager.switchProject(chatId, name);
      if (!path) {
        ctx.reply(`Project \`${name}\` not found.`, { parse_mode: "Markdown" });
        return;
      }
      // Clear session when switching projects
      sessionManager.clear(chatId);
      await Promise.all([projectManager.save(), sessionManager.save()]);
      ctx.reply(`Switched to \`${name}\` (\`${path}\`). Session cleared.`, { parse_mode: "Markdown" });
      return;
    }

    if (subcommand === "remove") {
      const name = args[1];
      if (!name) {
        ctx.reply("Usage: `/project remove <name>`", { parse_mode: "Markdown" });
        return;
      }
      if (projectManager.remove(name)) {
        await projectManager.save();
        ctx.reply(`Project \`${name}\` removed.`, { parse_mode: "Markdown" });
      } else {
        ctx.reply(`Project \`${name}\` not found.`, { parse_mode: "Markdown" });
      }
      return;
    }

    ctx.reply("Unknown subcommand. Use: list, add, switch, remove");
  });

  // /git command
  bot.command("git", async (ctx) => {
    const chatId = ctx.chat.id;
    const args = (ctx.match as string || "").trim();
    const subcommand = args.split(/\s+/)[0]?.toLowerCase();

    if (!subcommand) {
      ctx.reply(
        "Usage:\n" +
        "/git status - Show git status\n" +
        "/git commit - Create a commit\n" +
        "/git push - Push to remote\n" +
        "/git pr - Create a pull request"
      );
      return;
    }

    const prompts: Record<string, string> = {
      status: "Run git status and git log --oneline -5, then give me a concise summary.",
      commit: "Review the current changes with git diff, then create a commit with an appropriate message. Show the result.",
      push: "Push the current branch to origin. Show the result.",
      pr: "Create a pull request for the current branch. Show the result.",
    };

    const prompt = prompts[subcommand];
    if (!prompt) {
      ctx.reply(`Unknown git subcommand: ${subcommand}. Use: status, commit, push, pr`);
      return;
    }

    if (chatLocks.isLocked(chatId)) {
      ctx.reply("Still processing a previous request. Use /cancel to abort it.");
      return;
    }

    const controller = chatLocks.lock(chatId);
    const stopTyping = startTypingIndicator(ctx);

    try {
      const projectDir = projectManager.getActiveProjectDir(chatId) || config.defaultProjectDir;
      const sessionId = sessionManager.getSessionId(chatId);

      const result = await invokeClaude({
        prompt,
        cwd: projectDir,
        sessionId,
        abortSignal: controller.signal,
        config,
      });

      if (result.sessionId) {
        sessionManager.set(chatId, result.sessionId, projectDir);
        await sessionManager.save();
      }

      await sendResponse(ctx, result.result || "(empty response)");
    } catch (err: any) {
      if (err.message === "Cancelled") return;
      logger.error({ chatId, err }, "Error in git command");
      await ctx.reply(`Error: ${err.message}`).catch(() => {});
    } finally {
      stopTyping();
      chatLocks.unlock(chatId);
    }
  });
}

function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
