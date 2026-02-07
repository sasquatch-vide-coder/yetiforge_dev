import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { logger } from "./utils/logger.js";

export interface PendingResponse {
  id: string;
  chatId: number;
  responseText: string;
  overallSuccess: boolean;
  createdAt: number;
}

/**
 * Manages pending responses that haven't been delivered to users yet.
 * Uses synchronous file writes to survive process death — if the process
 * is killed between persisting and sending, the response survives on disk
 * and gets delivered after restart.
 */
export class PendingResponseManager {
  private responses: PendingResponse[] = [];
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "pending-responses.json");
  }

  /** Load pending responses from disk. Call on startup. */
  load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      this.responses = JSON.parse(raw);
      if (this.responses.length > 0) {
        logger.info({ count: this.responses.length }, "Loaded pending responses from disk");
      }
    } catch {
      this.responses = [];
    }
  }

  /** Persist a response to disk BEFORE sending it. Returns the record ID. */
  add(chatId: number, responseText: string, overallSuccess: boolean): string {
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record: PendingResponse = {
      id,
      chatId,
      responseText,
      overallSuccess,
      createdAt: Date.now(),
    };
    this.responses.push(record);
    this.saveToDisk();
    logger.debug({ id, chatId }, "Pending response persisted to disk");
    return id;
  }

  /** Remove a response after successful delivery. */
  remove(id: string): void {
    const before = this.responses.length;
    this.responses = this.responses.filter((r) => r.id !== id);
    if (this.responses.length !== before) {
      this.saveToDisk();
      logger.debug({ id }, "Pending response removed after successful delivery");
    }
  }

  /** Get all pending responses (for startup recovery). */
  getAll(): PendingResponse[] {
    return [...this.responses];
  }

  /** Check if there are any pending responses. */
  hasPending(): boolean {
    return this.responses.length > 0;
  }

  /** Synchronous write — survives process death. */
  private saveToDisk(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.responses, null, 2));
    } catch (err) {
      logger.error({ err }, "Failed to persist pending responses to disk");
    }
  }
}
