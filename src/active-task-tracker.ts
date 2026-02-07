import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { logger } from "./utils/logger.js";

export interface ActiveTask {
  id: string;
  chatId: number;
  sessionId: string;
  task: string;
  complexity: string;
  cwd: string;
  startedAt: number;
}

/**
 * Tracks active executor tasks to disk using synchronous writes.
 * If the process crashes mid-execution, we can detect interrupted tasks
 * on startup and notify the user with the session ID for --resume.
 */
export class ActiveTaskTracker {
  private tasks: ActiveTask[] = [];
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "active-tasks.json");
  }

  /** Load active tasks from disk. Call on startup. */
  load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      this.tasks = JSON.parse(raw);
      if (this.tasks.length > 0) {
        logger.info({ count: this.tasks.length }, "Loaded active tasks from disk (possible crash recovery)");
      }
    } catch {
      this.tasks = [];
    }
  }

  /** Track a new active task. Call BEFORE execution starts. Returns the task ID. */
  track(opts: {
    chatId: number;
    sessionId: string;
    task: string;
    complexity: string;
    cwd: string;
  }): string {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: ActiveTask = {
      id,
      chatId: opts.chatId,
      sessionId: opts.sessionId,
      task: opts.task,
      complexity: opts.complexity,
      cwd: opts.cwd,
      startedAt: Date.now(),
    };
    this.tasks.push(entry);
    this.saveToDisk();
    logger.debug({ id, chatId: opts.chatId, sessionId: opts.sessionId }, "Active task tracked");
    return id;
  }

  /** Update the session ID for a tracked task (called when invoker returns a session ID). */
  updateSessionId(taskId: string, sessionId: string): void {
    const task = this.tasks.find((t) => t.id === taskId);
    if (task && sessionId) {
      task.sessionId = sessionId;
      this.saveToDisk();
      logger.debug({ taskId, sessionId }, "Active task session ID updated");
    }
  }

  /** Remove a task after completion (success or failure). */
  complete(taskId: string): void {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== taskId);
    if (this.tasks.length !== before) {
      this.saveToDisk();
      logger.debug({ taskId }, "Active task completed and removed from tracker");
    }
  }

  /** Get all active tasks (for startup crash detection). */
  getAll(): ActiveTask[] {
    return [...this.tasks];
  }

  /** Check if there are any interrupted tasks from a previous run. */
  hasInterrupted(): boolean {
    return this.tasks.length > 0;
  }

  /** Get interrupted tasks for a specific chat. */
  getForChat(chatId: number): ActiveTask[] {
    return this.tasks.filter((t) => t.chatId === chatId);
  }

  /** Clear all tracked tasks (e.g., after notifying user). */
  clearAll(): void {
    this.tasks = [];
    this.saveToDisk();
  }

  /** Remove a specific task by ID without marking complete (e.g., user dismissed). */
  remove(taskId: string): boolean {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== taskId);
    if (this.tasks.length !== before) {
      this.saveToDisk();
      return true;
    }
    return false;
  }

  /** Synchronous write — survives process death. */
  private saveToDisk(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.tasks, null, 2));
    } catch (err) {
      logger.error({ err }, "Failed to persist active tasks to disk");
    }
  }
}
