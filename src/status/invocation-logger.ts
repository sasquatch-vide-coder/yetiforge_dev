import { logger } from "../utils/logger.js";
import {
  getDatabase,
  insertInvocation,
  getRecentInvocations,
  getInvocationStats,
  closeDatabase,
  type InsertInvocationData,
  type InvocationStats,
  type InvocationRow,
} from "./database.js";

export interface InvocationEntry {
  timestamp: number;
  chatId: number;
  durationMs?: number;
  durationApiMs?: number;
  costUsd?: number;
  numTurns?: number;
  stopReason?: string;
  isError: boolean;
  tier?: "chat" | "orchestrator" | "worker";
  taskId?: string;
  modelUsage?: Record<string, any>;
}

export { InvocationStats };

export class InvocationLogger {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async load(): Promise<void> {
    // Initialize the database connection
    getDatabase(this.dataDir);
    const stats = getInvocationStats(this.dataDir);
    logger.info({ count: stats.totalInvocations }, "SQLite database loaded");
  }

  async log(entry: InvocationEntry): Promise<void> {
    try {
      const data: InsertInvocationData = {
        timestamp: entry.timestamp,
        chatId: entry.chatId,
        tier: entry.tier,
        durationMs: entry.durationMs,
        durationApiMs: entry.durationApiMs,
        costUsd: entry.costUsd,
        numTurns: entry.numTurns,
        stopReason: entry.stopReason,
        isError: entry.isError,
        modelUsage: entry.modelUsage,
      };
      insertInvocation(data, this.dataDir);
      logger.debug("Invocation logged to SQLite");
    } catch (err) {
      logger.error({ err }, "Failed to log invocation to SQLite");
    }
  }

  getRecent(n: number): InvocationEntry[] {
    const rows = getRecentInvocations(n, this.dataDir);
    return rows.map(rowToEntry);
  }

  async getLifetimeStats(): Promise<InvocationStats> {
    return getInvocationStats(this.dataDir);
  }

  close(): void {
    closeDatabase();
  }
}

/**
 * Convert a database row back to the InvocationEntry format
 * expected by the API consumers (dashboard, etc.)
 */
function rowToEntry(row: InvocationRow): InvocationEntry {
  return {
    timestamp: row.timestamp,
    chatId: row.chatId ?? 0,
    tier: row.tier as InvocationEntry["tier"],
    durationMs: row.durationMs ?? undefined,
    durationApiMs: row.durationApiMs ?? undefined,
    costUsd: row.costUsd ?? undefined,
    numTurns: row.numTurns ?? undefined,
    stopReason: row.stopReason ?? undefined,
    isError: row.isError === 1 || row.isError === true,
    modelUsage: row.modelUsage ? JSON.parse(row.modelUsage as string) : undefined,
  };
}
