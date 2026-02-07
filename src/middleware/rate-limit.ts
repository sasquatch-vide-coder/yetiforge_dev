import { Context, NextFunction } from "grammy";

export class ChatLocks {
  private locks = new Map<number, AbortController>();
  private executorBusy = new Set<number>();

  isLocked(chatId: number): boolean {
    return this.locks.has(chatId);
  }

  lock(chatId: number): AbortController {
    const controller = new AbortController();
    this.locks.set(chatId, controller);
    return controller;
  }

  unlock(chatId: number): void {
    this.locks.delete(chatId);
  }

  cancel(chatId: number): boolean {
    const controller = this.locks.get(chatId);
    if (controller) {
      controller.abort();
      this.locks.delete(chatId);
      return true;
    }
    return false;
  }

  /** Mark executor as busy for a chat (background execution running). */
  setExecutorBusy(chatId: number): void {
    this.executorBusy.add(chatId);
  }

  /** Mark executor as idle for a chat. */
  setExecutorIdle(chatId: number): void {
    this.executorBusy.delete(chatId);
  }

  /** Check if executor is currently running for a chat. */
  isExecutorBusy(chatId: number): boolean {
    return this.executorBusy.has(chatId);
  }
}

export function rateLimitMiddleware(chatLocks: ChatLocks) {
  return (ctx: Context, next: NextFunction) => {
    // Only rate-limit text messages (not commands)
    if (ctx.message?.text && !ctx.message.text.startsWith("/")) {
      const chatId = ctx.chat?.id;
      if (chatId && chatLocks.isLocked(chatId)) {
        ctx.reply("Still processing your previous message. Use /cancel to abort it.").catch(() => {});
        return;
      }
    }
    return next();
  };
}
