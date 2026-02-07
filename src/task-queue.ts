import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { logger } from "./utils/logger.js";

const MAX_QUEUE_PER_CHAT = 5;

export interface QueuedTask {
  id: string;
  chatId: number;
  rawMessage: string;
  task: string;
  context: string;
  complexity: string;
  projectDir: string;
  memoryContext?: string;
  queuedAt: number;
}

export interface TaskQueueStats {
  chatId: number;
  queueLength: number;
  tasks: QueuedTask[];
}

/**
 * Per-chat task queue with persistent storage.
 * When the executor is busy, tasks are queued instead of rejected.
 * Persists to data/task-queue.json with synchronous writes (survives restarts).
 */
export class TaskQueue {
  private queues = new Map<number, QueuedTask[]>();
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "task-queue.json");
  }

  /** Load queued tasks from disk. Call on startup. */
  load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data: Record<string, QueuedTask[]> = JSON.parse(raw);
      this.queues = new Map();
      for (const [chatIdStr, tasks] of Object.entries(data)) {
        const chatId = parseInt(chatIdStr, 10);
        if (!isNaN(chatId) && Array.isArray(tasks) && tasks.length > 0) {
          this.queues.set(chatId, tasks);
        }
      }
      const totalQueued = this.getTotalCount();
      if (totalQueued > 0) {
        logger.info({ totalQueued }, "Loaded queued tasks from disk");
      }
    } catch {
      this.queues = new Map();
    }
  }

  /** Add a task to the queue for a specific chat. Returns the queued task, or null if queue is full. */
  enqueue(opts: {
    chatId: number;
    rawMessage: string;
    task: string;
    context: string;
    complexity: string;
    projectDir: string;
    memoryContext?: string;
  }): QueuedTask | null {
    const chatQueue = this.queues.get(opts.chatId) || [];

    if (chatQueue.length >= MAX_QUEUE_PER_CHAT) {
      return null; // Queue full
    }

    const task: QueuedTask = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId: opts.chatId,
      rawMessage: opts.rawMessage,
      task: opts.task,
      context: opts.context,
      complexity: opts.complexity,
      projectDir: opts.projectDir,
      memoryContext: opts.memoryContext,
      queuedAt: Date.now(),
    };

    chatQueue.push(task);
    this.queues.set(opts.chatId, chatQueue);
    this.saveToDisk();

    logger.info({ taskId: task.id, chatId: opts.chatId, position: chatQueue.length }, "Task queued");
    return task;
  }

  /** Dequeue the next task for a specific chat. Returns null if queue is empty. */
  dequeue(chatId: number): QueuedTask | null {
    const chatQueue = this.queues.get(chatId);
    if (!chatQueue || chatQueue.length === 0) {
      return null;
    }

    const task = chatQueue.shift()!;
    if (chatQueue.length === 0) {
      this.queues.delete(chatId);
    }
    this.saveToDisk();

    logger.info({ taskId: task.id, chatId, remaining: chatQueue.length }, "Task dequeued");
    return task;
  }

  /** Peek at the queue for a specific chat without removing anything. */
  peek(chatId: number): QueuedTask[] {
    return [...(this.queues.get(chatId) || [])];
  }

  /** Get queue length for a specific chat. */
  getQueueLength(chatId: number): number {
    return (this.queues.get(chatId) || []).length;
  }

  /** Cancel a specific queued task by ID. Returns the removed task, or null. */
  cancel(taskId: string): QueuedTask | null {
    for (const [chatId, chatQueue] of this.queues) {
      const idx = chatQueue.findIndex((t) => t.id === taskId);
      if (idx !== -1) {
        const [removed] = chatQueue.splice(idx, 1);
        if (chatQueue.length === 0) {
          this.queues.delete(chatId);
        }
        this.saveToDisk();
        logger.info({ taskId, chatId }, "Queued task cancelled");
        return removed;
      }
    }
    return null;
  }

  /** Cancel a queued task by position (1-indexed) for a chat. Returns the removed task, or null. */
  cancelByPosition(chatId: number, position: number): QueuedTask | null {
    const chatQueue = this.queues.get(chatId);
    if (!chatQueue || position < 1 || position > chatQueue.length) {
      return null;
    }

    const [removed] = chatQueue.splice(position - 1, 1);
    if (chatQueue.length === 0) {
      this.queues.delete(chatId);
    }
    this.saveToDisk();
    logger.info({ taskId: removed.id, chatId, position }, "Queued task cancelled by position");
    return removed;
  }

  /** Clear all queued tasks for a specific chat. Returns count of cleared tasks. */
  clearChat(chatId: number): number {
    const chatQueue = this.queues.get(chatId);
    if (!chatQueue || chatQueue.length === 0) return 0;

    const count = chatQueue.length;
    this.queues.delete(chatId);
    this.saveToDisk();
    logger.info({ chatId, count }, "Chat queue cleared");
    return count;
  }

  /** Get total count of queued tasks across all chats. */
  getTotalCount(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /** Get all chats that have queued tasks. */
  getChatsWithQueued(): number[] {
    return [...this.queues.keys()];
  }

  /** Get stats for a specific chat. */
  getStats(chatId: number): TaskQueueStats {
    const tasks = this.peek(chatId);
    return {
      chatId,
      queueLength: tasks.length,
      tasks,
    };
  }

  /** Check if any chats have queued tasks (for startup recovery). */
  hasQueued(): boolean {
    return this.queues.size > 0;
  }

  /** Synchronous write — survives process death. */
  private saveToDisk(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const data: Record<string, QueuedTask[]> = {};
      for (const [chatId, tasks] of this.queues) {
        data[chatId.toString()] = tasks;
      }
      writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.error({ err }, "Failed to persist task queue to disk");
    }
  }
}
