import "dotenv/config";

export interface Config {
  telegramBotToken: string;
  allowedUserIds: number[];
  defaultProjectDir: string;
  claudeCliPath: string;
  maxTurns: number;
  claudeTimeoutMs: number;
  dataDir: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    allowedUserIds: requireEnv("ALLOWED_USER_IDS")
      .split(",")
      .map((id) => {
        const parsed = parseInt(id.trim(), 10);
        if (isNaN(parsed)) throw new Error(`Invalid user ID: ${id}`);
        return parsed;
      }),
    defaultProjectDir:
      process.env.DEFAULT_PROJECT_DIR || process.cwd(),
    claudeCliPath: process.env.CLAUDE_CLI_PATH || "claude",
    maxTurns: parseInt(process.env.MAX_TURNS || "10", 10),
    claudeTimeoutMs: parseInt(process.env.CLAUDE_TIMEOUT_MS || "300000", 10),
    dataDir: process.env.DATA_DIR || "./data",
  };
}
