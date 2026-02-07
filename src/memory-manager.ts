import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { logger } from "./utils/logger.js";

export interface MemoryNote {
  id: string;
  text: string;
  createdAt: number;
  source: "auto" | "manual";
}

interface MemoryData {
  [chatId: string]: {
    notes: MemoryNote[];
  };
}

const MAX_NOTES_PER_USER = 50;
const MAX_CONTEXT_NOTES = 20; // Only inject the most recent N notes into prompt

/**
 * Manages persistent memory notes per user.
 * Stores durable facts, preferences, and patterns that survive across sessions.
 */
export class MemoryManager {
  private data: MemoryData = {};
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "memory.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.data = JSON.parse(raw);
      const totalNotes = Object.values(this.data).reduce((sum, d) => sum + d.notes.length, 0);
      if (totalNotes > 0) {
        logger.info({ totalNotes, users: Object.keys(this.data).length }, "Memory loaded");
      }
    } catch {
      logger.info("No existing memory file, starting fresh");
    }
  }

  async save(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2));
    logger.debug("Memory saved");
  }

  getNotes(chatId: number): MemoryNote[] {
    return this.data[String(chatId)]?.notes || [];
  }

  addNote(chatId: number, text: string, source: "auto" | "manual"): MemoryNote {
    const key = String(chatId);
    if (!this.data[key]) {
      this.data[key] = { notes: [] };
    }

    // Deduplicate: don't save if a very similar note already exists
    const existing = this.data[key].notes;
    const lowerText = text.toLowerCase().trim();
    const isDuplicate = existing.some(
      (n) => n.text.toLowerCase().trim() === lowerText
    );
    if (isDuplicate) {
      logger.debug({ chatId, text }, "Duplicate memory note, skipping");
      return existing.find((n) => n.text.toLowerCase().trim() === lowerText)!;
    }

    const note: MemoryNote = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: text.trim(),
      createdAt: Date.now(),
      source,
    };

    existing.push(note);

    // Cap at max notes per user (remove oldest)
    while (existing.length > MAX_NOTES_PER_USER) {
      existing.shift();
    }

    this.save().catch((err) => logger.error({ err }, "Failed to save memory"));
    logger.info({ chatId, noteId: note.id, source, text: text.slice(0, 80) }, "Memory note saved");
    return note;
  }

  removeNote(chatId: number, noteId: string): boolean {
    const key = String(chatId);
    const entry = this.data[key];
    if (!entry) return false;

    const before = entry.notes.length;
    entry.notes = entry.notes.filter((n) => n.id !== noteId);
    if (entry.notes.length === before) return false;

    this.save().catch((err) => logger.error({ err }, "Failed to save memory"));
    return true;
  }

  clearNotes(chatId: number): void {
    const key = String(chatId);
    delete this.data[key];
    this.save().catch((err) => logger.error({ err }, "Failed to save memory"));
  }

  /**
   * Build a memory context string for prompt injection.
   * Returns null if no notes exist for this user.
   */
  buildMemoryContext(chatId: number): string | null {
    const notes = this.getNotes(chatId);
    if (notes.length === 0) return null;

    // Take the most recent N notes
    const recent = notes.slice(-MAX_CONTEXT_NOTES);

    return [
      "[MEMORY CONTEXT — Things you remember about this user:]",
      ...recent.map((n, i) => `${i + 1}. ${n.text}`),
      "[END MEMORY CONTEXT]",
    ].join("\n");
  }
}
