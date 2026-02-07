import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { logger } from "./utils/logger.js";

export interface Webhook {
  id: string;
  secret: string;
  chatId: number;
  name: string;
  task: string;
  enabled: boolean;
  createdAt: number;
  lastTriggeredAt: number | null;
  lastResult: string | null;
  lastSuccess: boolean | null;
}

type WebhookTriggerHandler = (webhook: Webhook, payload?: any) => Promise<void>;

/**
 * Manages webhook triggers for external systems.
 * Each webhook has a unique secret for authentication.
 */
export class WebhookManager {
  private webhooks: Webhook[] = [];
  private filePath: string;
  private triggerHandler: WebhookTriggerHandler | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "webhooks.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.webhooks = JSON.parse(raw);
      if (this.webhooks.length > 0) {
        logger.info({ count: this.webhooks.length }, "Webhooks loaded");
      }
    } catch {
      logger.info("No existing webhooks file, starting fresh");
    }
  }

  async save(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.webhooks, null, 2));
  }

  setTriggerHandler(handler: WebhookTriggerHandler): void {
    this.triggerHandler = handler;
  }

  createWebhook(chatId: number, name: string, task: string): Webhook {
    const webhook: Webhook = {
      id: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      secret: randomBytes(24).toString("hex"),
      chatId,
      name,
      task,
      enabled: true,
      createdAt: Date.now(),
      lastTriggeredAt: null,
      lastResult: null,
      lastSuccess: null,
    };

    this.webhooks.push(webhook);
    this.save().catch((err) => logger.error({ err }, "Failed to save webhooks"));

    logger.info({ id: webhook.id, chatId, name }, "Webhook created");
    return webhook;
  }

  getWebhookById(id: string): Webhook | undefined {
    return this.webhooks.find((w) => w.id === id);
  }

  getWebhookBySecret(secret: string): Webhook | undefined {
    return this.webhooks.find((w) => w.secret === secret);
  }

  getWebhooksForChat(chatId: number): Webhook[] {
    return this.webhooks.filter((w) => w.chatId === chatId);
  }

  getAllWebhooks(): Webhook[] {
    return [...this.webhooks];
  }

  removeWebhook(id: string): boolean {
    const idx = this.webhooks.findIndex((w) => w.id === id);
    if (idx === -1) return false;

    const webhook = this.webhooks[idx];
    this.webhooks.splice(idx, 1);
    this.save().catch((err) => logger.error({ err }, "Failed to save webhooks"));

    logger.info({ id, name: webhook.name }, "Webhook removed");
    return true;
  }

  enableWebhook(id: string): boolean {
    const webhook = this.webhooks.find((w) => w.id === id);
    if (!webhook) return false;
    webhook.enabled = true;
    this.save().catch((err) => logger.error({ err }, "Failed to save webhooks"));
    return true;
  }

  disableWebhook(id: string): boolean {
    const webhook = this.webhooks.find((w) => w.id === id);
    if (!webhook) return false;
    webhook.enabled = false;
    this.save().catch((err) => logger.error({ err }, "Failed to save webhooks"));
    return true;
  }

  async trigger(id: string, payload?: any): Promise<boolean> {
    const webhook = this.webhooks.find((w) => w.id === id);
    if (!webhook || !webhook.enabled) return false;

    webhook.lastTriggeredAt = Date.now();

    if (!this.triggerHandler) {
      logger.warn({ id }, "No trigger handler set for webhook");
      return false;
    }

    try {
      await this.triggerHandler(webhook, payload);
      webhook.lastSuccess = true;
      webhook.lastResult = "Completed successfully";
    } catch (err: any) {
      webhook.lastSuccess = false;
      webhook.lastResult = err.message || "Unknown error";
      logger.error({ id, err }, "Webhook trigger failed");
    }

    this.save().catch((err) => logger.error({ err }, "Failed to save webhooks after trigger"));
    return true;
  }

  /**
   * Returns webhooks with secrets masked for API listing.
   */
  listMasked(): Array<Omit<Webhook, "secret"> & { secret: string }> {
    return this.webhooks.map((w) => ({
      ...w,
      secret: w.secret.slice(0, 8) + "..." + w.secret.slice(-4),
    }));
  }
}
