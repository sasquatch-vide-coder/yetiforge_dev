import { Bot } from "grammy";
import { Config } from "./config.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimitMiddleware, ChatLocks } from "./middleware/rate-limit.js";
import { registerCommands } from "./handlers/commands.js";
import { handleMessage } from "./handlers/message.js";
import { SessionManager } from "./claude/session-manager.js";
import { ProjectManager } from "./projects/project-manager.js";
import { logger } from "./utils/logger.js";

export function createBot(
  config: Config,
  sessionManager: SessionManager,
  projectManager: ProjectManager
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

  // Register commands
  registerCommands(bot, config, sessionManager, projectManager, chatLocks);

  // Default message handler
  bot.on("message:text", (ctx) =>
    handleMessage(ctx, config, sessionManager, projectManager, chatLocks)
  );

  return bot;
}
