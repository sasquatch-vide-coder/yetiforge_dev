import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { logger } from "../utils/logger.js";
import type { AgentTier } from "./types.js";

export interface StallThresholds {
  trivialMs: number;
  moderateMs: number;
  complexMs: number;
}

export interface AgentTierConfig {
  model: string;
  timeoutMs: number;
  stallWarning?: StallThresholds;
  stallKill?: StallThresholds;
  stallGraceMultiplier?: number;
}

export interface AgentConfigData {
  chat: AgentTierConfig;
  executor: AgentTierConfig;
}

export const DEFAULT_STALL_WARNING: StallThresholds = {
  trivialMs: 2 * 60_000,     // 2 minutes
  moderateMs: 4 * 60_000,    // 4 minutes
  complexMs: 5 * 60_000,     // 5 minutes
};

export const DEFAULT_STALL_KILL: StallThresholds = {
  trivialMs: 5 * 60_000,     // 5 minutes
  moderateMs: 10 * 60_000,   // 10 minutes
  complexMs: 15 * 60_000,    // 15 minutes
};

export const DEFAULT_STALL_GRACE_MULTIPLIER = 1.5;

const DEFAULT_CONFIG: AgentConfigData = {
  chat: {
    model: "claude-haiku-4-5-20251001",
    timeoutMs: 30000,
  },
  executor: {
    model: "claude-opus-4-6",
    timeoutMs: 0,
    stallWarning: { ...DEFAULT_STALL_WARNING },
    stallKill: { ...DEFAULT_STALL_KILL },
    stallGraceMultiplier: DEFAULT_STALL_GRACE_MULTIPLIER,
  },
};

export class AgentConfigManager {
  private config: AgentConfigData = structuredClone(DEFAULT_CONFIG);
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "agent-config.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data = JSON.parse(raw) as Partial<AgentConfigData>;
      // Merge with defaults so new fields are always present
      // Also handle legacy configs that had orchestrator/worker keys
      this.config = {
        chat: { ...DEFAULT_CONFIG.chat, ...data.chat },
        executor: {
          ...DEFAULT_CONFIG.executor,
          ...data.executor,
          stallWarning: {
            ...DEFAULT_STALL_WARNING,
            ...data.executor?.stallWarning,
          },
          stallKill: {
            ...DEFAULT_STALL_KILL,
            ...data.executor?.stallKill,
          },
          stallGraceMultiplier:
            data.executor?.stallGraceMultiplier ?? DEFAULT_STALL_GRACE_MULTIPLIER,
        },
      };
      logger.info("Agent config loaded");
    } catch {
      logger.info("No existing agent config, using defaults");
    }
  }

  async save(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.config, null, 2));
    logger.debug("Agent config saved");
  }

  getConfig(tier: AgentTier): AgentTierConfig {
    return this.config[tier];
  }

  setModel(tier: AgentTier, model: string): void {
    this.config[tier].model = model;
  }

  setTimeoutMs(tier: AgentTier, ms: number): void {
    this.config[tier].timeoutMs = ms;
  }

  setStallWarning(tier: AgentTier, thresholds: StallThresholds): void {
    this.config[tier].stallWarning = thresholds;
  }

  setStallKill(tier: AgentTier, thresholds: StallThresholds): void {
    this.config[tier].stallKill = thresholds;
  }

  setStallGraceMultiplier(tier: AgentTier, multiplier: number): void {
    this.config[tier].stallGraceMultiplier = multiplier;
  }

  getStallWarning(tier: AgentTier): StallThresholds {
    return this.config[tier].stallWarning ?? { ...DEFAULT_STALL_WARNING };
  }

  getStallKill(tier: AgentTier): StallThresholds {
    return this.config[tier].stallKill ?? { ...DEFAULT_STALL_KILL };
  }

  getStallGraceMultiplier(tier: AgentTier): number {
    return this.config[tier].stallGraceMultiplier ?? DEFAULT_STALL_GRACE_MULTIPLIER;
  }

  getAll(): AgentConfigData {
    return structuredClone(this.config);
  }

  getDefaults(): AgentConfigData {
    return structuredClone(DEFAULT_CONFIG);
  }
}
