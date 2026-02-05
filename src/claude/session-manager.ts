import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { logger } from "../utils/logger.js";

interface SessionData {
  sessionId: string;
  projectDir: string;
  lastUsedAt: number;
}

export class SessionManager {
  private sessions = new Map<number, SessionData>();
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "sessions.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data: Record<string, SessionData> = JSON.parse(raw);
      for (const [key, value] of Object.entries(data)) {
        this.sessions.set(parseInt(key, 10), value);
      }
      logger.info({ count: this.sessions.size }, "Sessions loaded");
    } catch {
      logger.info("No existing sessions file, starting fresh");
    }
  }

  async save(): Promise<void> {
    const obj: Record<string, SessionData> = {};
    for (const [key, value] of this.sessions) {
      obj[String(key)] = value;
    }
    await mkdir(join(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(obj, null, 2));
    logger.debug("Sessions saved");
  }

  get(chatId: number): SessionData | undefined {
    return this.sessions.get(chatId);
  }

  set(chatId: number, sessionId: string, projectDir: string): void {
    this.sessions.set(chatId, {
      sessionId,
      projectDir,
      lastUsedAt: Date.now(),
    });
  }

  clear(chatId: number): void {
    this.sessions.delete(chatId);
  }

  getSessionId(chatId: number): string | undefined {
    return this.sessions.get(chatId)?.sessionId;
  }
}
