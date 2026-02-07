import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import { logger } from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../..");

export interface InvocationRow {
  id?: number;
  timestamp: number;
  chatId: number;
  tier?: string;
  durationMs?: number;
  durationApiMs?: number;
  costUsd?: number;
  numTurns?: number;
  stopReason?: string;
  isError: boolean | number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  modelUsage?: string; // JSON string
}

export interface InvocationStats {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalInvocations: number;
  firstRecordedAt: string;
  lastUpdatedAt: string;
}

let db: Database.Database | null = null;

function getDbPath(dataDir?: string): string {
  if (dataDir) {
    // If dataDir is absolute, use it directly; otherwise resolve from project root
    if (dataDir.startsWith("/")) {
      return join(dataDir, "invocations.db");
    }
    return join(PROJECT_ROOT, dataDir, "invocations.db");
  }
  return join(PROJECT_ROOT, "data", "invocations.db");
}

export function getDatabase(dataDir?: string): Database.Database {
  if (db) return db;

  const dbPath = getDbPath(dataDir);

  // Ensure directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read/write
  db.pragma("journal_mode = WAL");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      chatId INTEGER,
      tier TEXT,
      durationMs INTEGER,
      durationApiMs INTEGER,
      costUsd REAL DEFAULT 0,
      numTurns INTEGER DEFAULT 0,
      stopReason TEXT,
      isError INTEGER DEFAULT 0,
      inputTokens INTEGER DEFAULT 0,
      outputTokens INTEGER DEFAULT 0,
      cacheReadTokens INTEGER DEFAULT 0,
      cacheCreationTokens INTEGER DEFAULT 0,
      modelUsage TEXT
    )
  `);

  // Create index on timestamp for efficient ordering
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_invocations_timestamp ON invocations(timestamp)
  `);

  logger.info({ dbPath }, "SQLite database initialized");

  return db;
}

/**
 * Extract aggregated token counts from the modelUsage JSON object.
 * Each model entry contains inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens.
 */
function extractTokens(modelUsage: Record<string, any> | undefined | null): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  if (modelUsage) {
    for (const model of Object.values(modelUsage)) {
      inputTokens += (model.inputTokens || 0) + (model.cacheCreationInputTokens || 0);
      outputTokens += model.outputTokens || 0;
      cacheReadTokens += model.cacheReadInputTokens || 0;
      cacheCreationTokens += model.cacheCreationInputTokens || 0;
    }
  }

  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

export interface InsertInvocationData {
  timestamp: number;
  chatId: number;
  tier?: string;
  durationMs?: number;
  durationApiMs?: number;
  costUsd?: number;
  numTurns?: number;
  stopReason?: string;
  isError: boolean;
  modelUsage?: Record<string, any>;
}

export function insertInvocation(data: InsertInvocationData, dataDir?: string): void {
  const database = getDatabase(dataDir);
  const tokens = extractTokens(data.modelUsage);

  const stmt = database.prepare(`
    INSERT INTO invocations (timestamp, chatId, tier, durationMs, durationApiMs, costUsd, numTurns, stopReason, isError, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelUsage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    data.timestamp,
    data.chatId,
    data.tier || null,
    data.durationMs || null,
    data.durationApiMs || null,
    data.costUsd || 0,
    data.numTurns || 0,
    data.stopReason || null,
    data.isError ? 1 : 0,
    tokens.inputTokens,
    tokens.outputTokens,
    tokens.cacheReadTokens,
    tokens.cacheCreationTokens,
    data.modelUsage ? JSON.stringify(data.modelUsage) : null,
  );
}

export function getAllInvocations(dataDir?: string): InvocationRow[] {
  const database = getDatabase(dataDir);
  return database.prepare(`
    SELECT * FROM invocations ORDER BY timestamp DESC
  `).all() as InvocationRow[];
}

export function getRecentInvocations(n: number, dataDir?: string): InvocationRow[] {
  const database = getDatabase(dataDir);
  return database.prepare(`
    SELECT * FROM invocations ORDER BY timestamp DESC LIMIT ?
  `).all(n) as InvocationRow[];
}

export function getInvocationStats(dataDir?: string): InvocationStats {
  const database = getDatabase(dataDir);

  const row = database.prepare(`
    SELECT
      COUNT(*) as totalInvocations,
      COALESCE(SUM(costUsd), 0) as totalCost,
      COALESCE(SUM(inputTokens), 0) as totalInputTokens,
      COALESCE(SUM(outputTokens), 0) as totalOutputTokens,
      COALESCE(SUM(cacheReadTokens), 0) as totalCacheReadTokens,
      COALESCE(SUM(cacheCreationTokens), 0) as totalCacheCreationTokens,
      MIN(timestamp) as firstTimestamp,
      MAX(timestamp) as lastTimestamp
    FROM invocations
  `).get() as any;

  return {
    totalCost: row.totalCost,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    totalCacheReadTokens: row.totalCacheReadTokens,
    totalCacheCreationTokens: row.totalCacheCreationTokens,
    totalInvocations: row.totalInvocations,
    firstRecordedAt: row.firstTimestamp
      ? new Date(row.firstTimestamp).toISOString()
      : new Date().toISOString(),
    lastUpdatedAt: row.lastTimestamp
      ? new Date(row.lastTimestamp).toISOString()
      : new Date().toISOString(),
  };
}

export interface DailyStatsRow {
  date: string;
  cost: number;
  totalTokens: number;
}

export function getDailyStats(dataDir?: string): DailyStatsRow[] {
  const database = getDatabase(dataDir);

  // Query aggregated daily stats for the last 30 days
  const rows = database.prepare(`
    SELECT
      date(timestamp/1000, 'unixepoch') as date,
      COALESCE(SUM(costUsd), 0) as cost,
      COALESCE(SUM(inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens), 0) as totalTokens
    FROM invocations
    WHERE timestamp >= (strftime('%s','now') - 30*86400) * 1000
    GROUP BY date(timestamp/1000, 'unixepoch')
    ORDER BY date ASC
  `).all() as DailyStatsRow[];

  // Build a map of query results keyed by date
  const resultMap = new Map<string, DailyStatsRow>();
  for (const row of rows) {
    resultMap.set(row.date, {
      date: row.date,
      cost: Math.round(row.cost * 10000) / 10000,
      totalTokens: row.totalTokens || 0,
    });
  }

  // Fill in all 30 days so there are no gaps
  const dailyStats: DailyStatsRow[] = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
    dailyStats.push(resultMap.get(dateStr) || { date: dateStr, cost: 0, totalTokens: 0 });
  }

  return dailyStats;
}

/**
 * Close the database connection (for graceful shutdown).
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
