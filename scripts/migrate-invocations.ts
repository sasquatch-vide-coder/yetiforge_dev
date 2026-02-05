/**
 * Migration script: Import invocations from JSON to SQLite
 *
 * Usage: npx tsx scripts/migrate-invocations.ts
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { insertInvocation, getDatabase, closeDatabase } from "../src/status/database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const JSON_PATH = join(DATA_DIR, "invocations.json");

interface JsonInvocationEntry {
  timestamp: number;
  chatId: number;
  tier?: string;
  durationMs?: number;
  durationApiMs?: number;
  costUsd?: number;
  numTurns?: number;
  stopReason?: string;
  isError: boolean;
  taskId?: string;
  modelUsage?: Record<string, any>;
}

async function migrate(): Promise<void> {
  console.log("=== Invocations JSON -> SQLite Migration ===\n");

  // Read JSON file
  let entries: JsonInvocationEntry[];
  try {
    const raw = readFileSync(JSON_PATH, "utf-8");
    entries = JSON.parse(raw);
    console.log(`Read ${entries.length} entries from ${JSON_PATH}`);
  } catch (err) {
    console.error(`Failed to read ${JSON_PATH}:`, err);
    process.exit(1);
  }

  // Initialize database
  const db = getDatabase(DATA_DIR);
  console.log(`Database initialized at ${DATA_DIR}/invocations.db`);

  // Check if there are already entries in the database
  const existingCount = (db.prepare("SELECT COUNT(*) as count FROM invocations").get() as any).count;
  if (existingCount > 0) {
    console.log(`\nWARNING: Database already contains ${existingCount} entries.`);
    console.log("Clearing existing entries before migration...");
    db.prepare("DELETE FROM invocations").run();
  }

  // Insert entries
  let migrated = 0;
  let errors = 0;

  const insertStmt = db.prepare(`
    INSERT INTO invocations (timestamp, chatId, tier, durationMs, durationApiMs, costUsd, numTurns, stopReason, isError, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelUsage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Use a transaction for bulk insert performance
  const insertAll = db.transaction((entries: JsonInvocationEntry[]) => {
    for (const entry of entries) {
      try {
        // Extract token counts from modelUsage
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;

        if (entry.modelUsage) {
          for (const model of Object.values(entry.modelUsage)) {
            inputTokens += (model.inputTokens || 0) + (model.cacheCreationInputTokens || 0);
            outputTokens += model.outputTokens || 0;
            cacheReadTokens += model.cacheReadInputTokens || 0;
            cacheCreationTokens += model.cacheCreationInputTokens || 0;
          }
        }

        insertStmt.run(
          entry.timestamp,
          entry.chatId,
          entry.tier || null,
          entry.durationMs || null,
          entry.durationApiMs || null,
          entry.costUsd || 0,
          entry.numTurns || 0,
          entry.stopReason || null,
          entry.isError ? 1 : 0,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          entry.modelUsage ? JSON.stringify(entry.modelUsage) : null,
        );

        migrated++;
      } catch (err) {
        console.error(`  Error migrating entry at timestamp ${entry.timestamp}:`, err);
        errors++;
      }
    }
  });

  insertAll(entries);

  // Verify
  const finalCount = (db.prepare("SELECT COUNT(*) as count FROM invocations").get() as any).count;
  const totalCost = (db.prepare("SELECT COALESCE(SUM(costUsd), 0) as total FROM invocations").get() as any).total;

  console.log(`\n=== Migration Complete ===`);
  console.log(`  JSON entries:    ${entries.length}`);
  console.log(`  Migrated:        ${migrated}`);
  console.log(`  Errors:          ${errors}`);
  console.log(`  DB row count:    ${finalCount}`);
  console.log(`  Total cost (DB): $${totalCost.toFixed(4)}`);

  if (finalCount === entries.length) {
    console.log(`\n  All entries migrated successfully.`);
  } else {
    console.log(`\n  WARNING: Count mismatch! Expected ${entries.length}, got ${finalCount}`);
  }

  closeDatabase();
  console.log("\nDone. invocations.json has been kept as a backup.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
