/**
 * In-memory store for pending plans, keyed by chatId.
 *
 * When the executor runs in "plan" mode, it produces a plan summary.
 * That plan is stored here until the user approves, revises, or cancels it.
 * On approval, the stored plan context is used to launch execution mode.
 */

import { logger } from "./utils/logger.js";

export interface PendingPlan {
  chatId: number;
  /** The original task description from the work request */
  task: string;
  /** The original context from the work request */
  context: string;
  /** The plan text produced by the executor in plan mode */
  planText: string;
  /** Complexity level for timeout calculation */
  complexity: string;
  /** Project directory for execution */
  projectDir: string;
  /** Raw user message that triggered the plan */
  rawMessage: string;
  /** Memory context at the time of planning */
  memoryContext?: string;
  /** Timestamp when the plan was created */
  createdAt: number;
  /** How many times the plan has been revised */
  revisionCount: number;
}

export class PlanStore {
  private plans = new Map<number, PendingPlan>();

  /** Store a pending plan for a chat. Replaces any existing plan. */
  set(chatId: number, plan: PendingPlan): void {
    this.plans.set(chatId, plan);
    logger.info({ chatId, task: plan.task, revisionCount: plan.revisionCount }, "Pending plan stored");
  }

  /** Retrieve the pending plan for a chat, or null if none exists. */
  get(chatId: number): PendingPlan | null {
    return this.plans.get(chatId) || null;
  }

  /** Remove and return the pending plan for a chat. */
  consume(chatId: number): PendingPlan | null {
    const plan = this.plans.get(chatId) || null;
    if (plan) {
      this.plans.delete(chatId);
      logger.info({ chatId, task: plan.task }, "Pending plan consumed");
    }
    return plan;
  }

  /** Check if a chat has a pending plan. */
  has(chatId: number): boolean {
    return this.plans.has(chatId);
  }

  /** Cancel (remove) a pending plan. */
  cancel(chatId: number): boolean {
    const had = this.plans.has(chatId);
    this.plans.delete(chatId);
    if (had) {
      logger.info({ chatId }, "Pending plan cancelled");
    }
    return had;
  }

  /** Get all pending plan chat IDs (for debugging/admin). */
  allChatIds(): number[] {
    return Array.from(this.plans.keys());
  }
}
