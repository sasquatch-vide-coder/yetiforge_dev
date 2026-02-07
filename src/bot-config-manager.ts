import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { logger } from "./utils/logger.js";

export interface BotConfigData {
  botName: string;
}

const DEFAULT_CONFIG: BotConfigData = {
  botName: "YETIFORGE",
};

export class BotConfigManager {
  private config: BotConfigData = structuredClone(DEFAULT_CONFIG);
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "bot-config.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data = JSON.parse(raw) as Partial<BotConfigData>;
      // Merge with defaults so new fields are always present
      this.config = {
        ...DEFAULT_CONFIG,
        ...data,
      };
      logger.info("Bot config loaded");
    } catch {
      logger.info("No existing bot config, using defaults");
    }
  }

  async save(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.config, null, 2));
    logger.debug("Bot config saved");
  }

  getBotName(): string {
    return this.config.botName;
  }

  setBotName(name: string): void {
    this.config.botName = name;
  }
}
