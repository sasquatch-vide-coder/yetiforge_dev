import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { logger } from "../utils/logger.js";

export type SessionScope = "chat" | "orchestrator";

interface SessionData {
  sessionId: string;
  projectDir: string;
  lastUsedAt: number;
  invocationCount?: number;
}

interface MultiScopeSessionData {
  chat?: SessionData;
  orchestrator?: SessionData;
}

export class SessionManager {
  private sessions = new Map<number, MultiScopeSessionData>();
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "sessions.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data: Record<string, unknown> = JSON.parse(raw);
      for (const [key, value] of Object.entries(data)) {
        const chatId = parseInt(key, 10);
        const entry = value as Record<string, unknown>;

        // Migration: old format has sessionId directly on the value
        if (typeof entry.sessionId === "string") {
          // Old format — migrate into chat scope
          this.sessions.set(chatId, {
            chat: entry as unknown as SessionData,
          });
        } else {
          // New format — already scoped
          this.sessions.set(chatId, entry as MultiScopeSessionData);
        }
      }
      logger.info({ count: this.sessions.size }, "Sessions loaded");
    } catch {
      logger.info("No existing sessions file, starting fresh");
    }
  }

  async save(): Promise<void> {
    const obj: Record<string, MultiScopeSessionData> = {};
    for (const [key, value] of this.sessions) {
      obj[String(key)] = value;
    }
    await mkdir(join(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(obj, null, 2));
    logger.debug("Sessions saved");
  }

  get(chatId: number, scope: SessionScope = "chat"): SessionData | undefined {
    return this.sessions.get(chatId)?.[scope];
  }

  set(
    chatId: number,
    sessionId: string,
    projectDir: string,
    scope: SessionScope = "chat"
  ): void {
    const existing = this.sessions.get(chatId) ?? {};
    existing[scope] = {
      sessionId,
      projectDir,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(chatId, existing);
  }

  clear(chatId: number, scope?: SessionScope): void {
    if (scope) {
      const existing = this.sessions.get(chatId);
      if (existing) {
        delete existing[scope];
        // If no scopes remain, remove the entire entry
        if (!existing.chat && !existing.orchestrator) {
          this.sessions.delete(chatId);
        }
      }
    } else {
      this.sessions.delete(chatId);
    }
  }

  getSessionId(
    chatId: number,
    scope: SessionScope = "chat"
  ): string | undefined {
    return this.sessions.get(chatId)?.[scope]?.sessionId;
  }

  /**
   * Increment the invocation counter for a session scope.
   * Returns true if the session should be rotated (counter >= maxInvocations).
   * When rotation is needed, the session is automatically cleared.
   */
  incrementAndCheck(
    chatId: number,
    scope: SessionScope = "chat",
    maxInvocations: number = 15,
  ): boolean {
    const existing = this.sessions.get(chatId);
    const session = existing?.[scope];
    if (!session) return false;

    const count = (session.invocationCount ?? 0) + 1;
    session.invocationCount = count;

    if (count >= maxInvocations) {
      logger.info({ chatId, scope, invocationCount: count, maxInvocations }, "Session rotation triggered — clearing stale session");
      this.clear(chatId, scope);
      return true;
    }

    return false;
  }
}
