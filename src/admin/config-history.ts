import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { logger } from "../utils/logger.js";

export interface ConfigSnapshot {
  id: string;
  timestamp: number;
  configType: string;
  data: any;
  changedBy: string;
}

export class ConfigHistory {
  private history: Map<string, ConfigSnapshot[]> = new Map();
  private filePath: string;
  private maxHistoryPerType: number;

  constructor(dataDir: string, maxHistoryPerType: number = 20) {
    this.filePath = join(dataDir, "config-history.json");
    this.maxHistoryPerType = maxHistoryPerType;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data = JSON.parse(raw);
      this.history = new Map(Object.entries(data));
      logger.info("Config history loaded");
    } catch {
      logger.info("No config history found — starting fresh");
    }
  }

  async save(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    const obj: Record<string, ConfigSnapshot[]> = {};
    for (const [key, val] of this.history) {
      obj[key] = val;
    }
    await writeFile(this.filePath, JSON.stringify(obj, null, 2));
  }

  async snapshot(configType: string, data: any, changedBy: string): Promise<string> {
    const id = `${configType}-${Date.now()}`;
    const entry: ConfigSnapshot = {
      id,
      timestamp: Date.now(),
      configType,
      data: JSON.parse(JSON.stringify(data)), // Deep clone
      changedBy,
    };

    if (!this.history.has(configType)) {
      this.history.set(configType, []);
    }

    const list = this.history.get(configType)!;
    list.unshift(entry);

    // Trim to max history
    if (list.length > this.maxHistoryPerType) {
      list.splice(this.maxHistoryPerType);
    }

    await this.save();
    return id;
  }

  getHistory(configType: string): ConfigSnapshot[] {
    return this.history.get(configType) || [];
  }

  getSnapshot(configType: string, id: string): ConfigSnapshot | null {
    const list = this.history.get(configType) || [];
    return list.find((s) => s.id === id) || null;
  }

  getLatest(configType: string): ConfigSnapshot | null {
    const list = this.history.get(configType) || [];
    return list[0] || null;
  }

  diff(before: any, after: any): Record<string, { old: any; new: any }> {
    const changes: Record<string, { old: any; new: any }> = {};
    const allKeys = new Set([
      ...Object.keys(before || {}),
      ...Object.keys(after || {}),
    ]);

    for (const key of allKeys) {
      const oldVal = before?.[key];
      const newVal = after?.[key];

      if (typeof oldVal === "object" && typeof newVal === "object" && oldVal !== null && newVal !== null) {
        const nested = this.diff(oldVal, newVal);
        for (const [nestedKey, change] of Object.entries(nested)) {
          changes[`${key}.${nestedKey}`] = change;
        }
      } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        changes[key] = { old: oldVal, new: newVal };
      }
    }

    return changes;
  }
}
