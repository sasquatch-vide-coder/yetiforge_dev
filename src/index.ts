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
import { ChatAgent } from "./agents/chat-agent.js";
import { Orchestrator } from "./agents/orchestrator.js";

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

  // Load personality for chat agent
  const personalityMd = await readFile(join(process.cwd(), "docs/personality.md"), "utf-8");

  // Create agents
  const chatAgent = new ChatAgent(config, agentConfig, sessionManager, personalityMd);
  const orchestrator = new Orchestrator(config, agentConfig, sessionManager);

  const bot = createBot(config, sessionManager, projectManager, invocationLogger, chatAgent, orchestrator, agentConfig);

  // Start status page server
  const statusPort = parseInt(process.env.STATUS_PORT || "3069", 10);
  const statusServer = await startStatusServer(config.dataDir, statusPort, {
    adminJwtSecret: config.adminJwtSecret,
    agentConfig,
    chatAgent,
    orchestrator,
    sessionManager,
    invocationLogger,
    defaultProjectDir: config.defaultProjectDir,
  });

  const shutdown = async () => {
    logger.info("Shutting down...");
    await bot.stop();
    await statusServer.close();
    await sessionManager.save();
    await projectManager.save();
    await agentConfig.save();
    invocationLogger.close();
    closeDatabase();
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
