import { loadConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { createBot } from "./bot.js";
import { SessionManager } from "./claude/session-manager.js";
import { ProjectManager } from "./projects/project-manager.js";

async function main() {
  const config = loadConfig();
  logger.info("Config loaded");

  const sessionManager = new SessionManager(config.dataDir);
  const projectManager = new ProjectManager(config.dataDir, config.defaultProjectDir);

  await sessionManager.load();
  await projectManager.load();

  const bot = createBot(config, sessionManager, projectManager);

  const shutdown = async () => {
    logger.info("Shutting down...");
    await bot.stop();
    await sessionManager.save();
    await projectManager.save();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("Starting bot...");
  await bot.start({
    onStart: () => logger.info("Bot is running"),
  });
}

main().catch((err) => {
  logger.fatal(err, "Fatal error");
  process.exit(1);
});
