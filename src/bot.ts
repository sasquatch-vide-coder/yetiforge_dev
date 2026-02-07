import { Bot } from "grammy";
import { Config } from "./config.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimitMiddleware, ChatLocks } from "./middleware/rate-limit.js";
import { registerCommands } from "./handlers/commands.js";
import { handleMessage } from "./handlers/message.js";
import { handleMedia } from "./handlers/media.js";
import { SessionManager } from "./claude/session-manager.js";
import { ProjectManager } from "./projects/project-manager.js";
import { InvocationLogger } from "./status/invocation-logger.js";
import { ChatAgent } from "./agents/chat-agent.js";
import { Executor } from "./agents/executor.js";
import { AgentConfigManager } from "./agents/agent-config.js";
import { PendingResponseManager } from "./pending-responses.js";
import { MemoryManager } from "./memory-manager.js";
import { CronManager } from "./cron-manager.js";
import { WebhookManager } from "./webhook-manager.js";
import { ActiveTaskTracker } from "./active-task-tracker.js";
import { TaskQueue } from "./task-queue.js";
import { logger } from "./utils/logger.js";

export function createBot(
  config: Config,
  sessionManager: SessionManager,
  projectManager: ProjectManager,
  invocationLogger: InvocationLogger,
  chatAgent: ChatAgent,
  executor: Executor,
  agentConfig: AgentConfigManager,
  pendingResponses?: PendingResponseManager,
  memoryManager?: MemoryManager,
  cronManager?: CronManager,
  webhookManager?: WebhookManager,
  activeTaskTracker?: ActiveTaskTracker,
  taskQueue?: TaskQueue,
): Bot {
  const bot = new Bot(config.telegramBotToken);
  const chatLocks = new ChatLocks();

  // Error handler
  bot.catch((err) => {
    logger.error(err, "Bot error");
  });

  // Auth middleware - must be first
  bot.use(authMiddleware(config.allowedUserIds));

  // Rate limit middleware
  bot.use(rateLimitMiddleware(chatLocks));

  // Register commands (pass all managers for new commands)
  registerCommands(
    bot, config, sessionManager, projectManager, chatLocks, agentConfig,
    executor, executor.getRegistry(),
    memoryManager, cronManager, webhookManager, chatAgent, activeTaskTracker, taskQueue,
  );

  // Default message handler
  bot.on("message:text", (ctx) =>
    handleMessage(ctx, config, sessionManager, projectManager, chatLocks, invocationLogger, chatAgent, executor, pendingResponses, memoryManager, taskQueue)
  );

  return bot;
}
