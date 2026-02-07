import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import cron from "node-cron";
import { logger } from "./utils/logger.js";

export interface CronJob {
  id: string;
  chatId: number;
  name: string;
  task: string;
  schedule: string; // cron expression
  type: "cron" | "once";
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  lastResult: string | null;
  lastSuccess: boolean | null;
}

type TriggerHandler = (job: CronJob) => Promise<void>;

/**
 * Manages scheduled cron jobs per user.
 * Jobs persist to disk and survive restarts.
 */
export class CronManager {
  private jobs: CronJob[] = [];
  private filePath: string;
  private scheduledTasks: Map<string, cron.ScheduledTask> = new Map();
  private triggerHandler: TriggerHandler | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "cron-jobs.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.jobs = JSON.parse(raw);
      if (this.jobs.length > 0) {
        logger.info({ count: this.jobs.length }, "Cron jobs loaded");
      }
    } catch {
      logger.info("No existing cron jobs file, starting fresh");
    }
  }

  async save(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.jobs, null, 2));
  }

  setTriggerHandler(handler: TriggerHandler): void {
    this.triggerHandler = handler;
  }

  /**
   * Register all enabled jobs with node-cron. Call after load() and after setting trigger handler.
   */
  startAll(): void {
    for (const job of this.jobs) {
      if (job.enabled && job.type === "cron") {
        this.scheduleJob(job);
      }
    }
    const enabled = this.jobs.filter((j) => j.enabled).length;
    if (enabled > 0) {
      logger.info({ enabled, total: this.jobs.length }, "Cron jobs started");
    }
  }

  /**
   * Stop all scheduled tasks.
   */
  stopAll(): void {
    for (const [id, task] of this.scheduledTasks) {
      task.stop();
      logger.debug({ id }, "Cron task stopped");
    }
    this.scheduledTasks.clear();
  }

  addJob(chatId: number, name: string, schedule: string, task: string, type: "cron" | "once" = "cron"): CronJob | string {
    // Validate cron expression
    if (!cron.validate(schedule)) {
      return `Invalid cron expression: "${schedule}". Use standard cron format (e.g., "*/5 * * * *" for every 5 minutes).`;
    }

    const job: CronJob = {
      id: `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      chatId,
      name,
      task,
      schedule,
      type,
      enabled: true,
      createdAt: Date.now(),
      lastRunAt: null,
      lastResult: null,
      lastSuccess: null,
    };

    this.jobs.push(job);
    this.save().catch((err) => logger.error({ err }, "Failed to save cron jobs"));

    if (type === "cron") {
      this.scheduleJob(job);
    }

    logger.info({ id: job.id, chatId, name, schedule }, "Cron job added");
    return job;
  }

  removeJob(jobId: string): boolean {
    const idx = this.jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return false;

    const job = this.jobs[idx];
    this.unscheduleJob(jobId);
    this.jobs.splice(idx, 1);
    this.save().catch((err) => logger.error({ err }, "Failed to save cron jobs"));

    logger.info({ id: jobId, name: job.name }, "Cron job removed");
    return true;
  }

  enableJob(jobId: string): boolean {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return false;

    job.enabled = true;
    if (job.type === "cron") {
      this.scheduleJob(job);
    }
    this.save().catch((err) => logger.error({ err }, "Failed to save cron jobs"));
    return true;
  }

  disableJob(jobId: string): boolean {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return false;

    job.enabled = false;
    this.unscheduleJob(jobId);
    this.save().catch((err) => logger.error({ err }, "Failed to save cron jobs"));
    return true;
  }

  getJobsForChat(chatId: number): CronJob[] {
    return this.jobs.filter((j) => j.chatId === chatId);
  }

  getAllJobs(): CronJob[] {
    return [...this.jobs];
  }

  getJob(jobId: string): CronJob | undefined {
    return this.jobs.find((j) => j.id === jobId);
  }

  /**
   * Trigger a job immediately (bypasses schedule).
   */
  async triggerNow(jobId: string): Promise<boolean> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return false;

    await this.executeJob(job);
    return true;
  }

  private scheduleJob(job: CronJob): void {
    // Don't double-schedule
    this.unscheduleJob(job.id);

    const task = cron.schedule(job.schedule, async () => {
      await this.executeJob(job);

      // If one-shot, disable after execution
      if (job.type === "once") {
        job.enabled = false;
        this.unscheduleJob(job.id);
        this.save().catch((err) => logger.error({ err }, "Failed to save cron jobs"));
      }
    });

    this.scheduledTasks.set(job.id, task);
  }

  private unscheduleJob(jobId: string): void {
    const existing = this.scheduledTasks.get(jobId);
    if (existing) {
      existing.stop();
      this.scheduledTasks.delete(jobId);
    }
  }

  private async executeJob(job: CronJob): Promise<void> {
    logger.info({ id: job.id, name: job.name, chatId: job.chatId }, "Cron job triggered");

    job.lastRunAt = Date.now();

    if (!this.triggerHandler) {
      logger.warn({ id: job.id }, "No trigger handler set, skipping execution");
      return;
    }

    try {
      await this.triggerHandler(job);
      job.lastSuccess = true;
      job.lastResult = "Completed successfully";
    } catch (err: any) {
      job.lastSuccess = false;
      job.lastResult = err.message || "Unknown error";
      logger.error({ id: job.id, err }, "Cron job execution failed");
    }

    this.save().catch((err) => logger.error({ err }, "Failed to save cron jobs after execution"));
  }
}
