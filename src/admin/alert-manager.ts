import { readFile, writeFile, mkdir } from "fs/promises";
import { execSync } from "child_process";
import { join } from "path";
import { logger } from "../utils/logger.js";
import { getDatabase } from "../status/database.js";

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertType =
  | "ssl_expiry"
  | "bot_crash"
  | "high_error_rate"
  | "disk_space"
  | "memory_high";

export interface Alert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  timestamp: number;
  acknowledged: boolean;
  details?: any;
}

export class AlertManager {
  private alerts: Alert[] = [];
  private filePath: string;
  private dataDir: string;
  private checkTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.filePath = join(dataDir, "alerts.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.alerts = JSON.parse(raw);
      // Prune very old acknowledged alerts (>7 days)
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      this.alerts = this.alerts.filter(
        (a) => !a.acknowledged || a.timestamp > cutoff
      );
      logger.info({ count: this.alerts.length }, "Alerts loaded");
    } catch {
      logger.info("No alerts file found — starting fresh");
    }
  }

  async save(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.alerts, null, 2));
  }

  startMonitoring(intervalMs: number = 5 * 60 * 1000): void {
    // Run checks immediately, then on interval
    this.runAllChecks().catch(() => {});
    this.checkTimer = setInterval(() => {
      this.runAllChecks().catch(() => {});
    }, intervalMs);
    if (this.checkTimer.unref) this.checkTimer.unref();
    logger.info({ intervalMs }, "Alert monitoring started");
  }

  stopMonitoring(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  private async runAllChecks(): Promise<void> {
    this.checkSSLExpiry();
    this.checkBotHealth();
    this.checkDiskSpace();
    this.checkMemory();
    await this.checkErrorRate();
    await this.save();
  }

  private addAlert(type: AlertType, severity: AlertSeverity, message: string, details?: any): void {
    // Don't duplicate unacknowledged alerts of the same type
    const existing = this.alerts.find(
      (a) => a.type === type && !a.acknowledged
    );
    if (existing) return;

    this.alerts.unshift({
      id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      severity,
      message,
      timestamp: Date.now(),
      acknowledged: false,
      details,
    });

    // Keep max 100 alerts
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(0, 100);
    }

    logger.warn({ type, severity, message }, "Alert created");
  }

  private removeUnacknowledgedByType(type: AlertType): void {
    this.alerts = this.alerts.filter(
      (a) => a.type !== type || a.acknowledged
    );
  }

  checkSSLExpiry(): void {
    try {
      const output = execSync("sudo certbot certificates 2>&1", {
        encoding: "utf-8",
        timeout: 10000,
      });
      const expiryMatch = output.match(/Expiry Date:\s+(.+?)(\s+\(|$)/);
      if (expiryMatch) {
        const expiry = new Date(expiryMatch[1].trim());
        const daysUntil = Math.floor(
          (expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );

        if (daysUntil <= 7) {
          this.addAlert(
            "ssl_expiry",
            "critical",
            `SSL certificate expires in ${daysUntil} day${daysUntil !== 1 ? "s" : ""}!`,
            { expiryDate: expiry.toISOString(), daysUntil }
          );
        } else if (daysUntil <= 30) {
          this.addAlert(
            "ssl_expiry",
            "warning",
            `SSL certificate expires in ${daysUntil} days`,
            { expiryDate: expiry.toISOString(), daysUntil }
          );
        } else {
          // Clear any existing SSL alerts if cert is fine
          this.removeUnacknowledgedByType("ssl_expiry");
        }
      }
    } catch {
      // Can't check SSL — not critical enough to alert about
    }
  }

  checkBotHealth(): void {
    try {
      const status = execSync("systemctl is-active tiffbot", {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      if (status !== "active") {
        this.addAlert(
          "bot_crash",
          "critical",
          `Bot service is ${status}`,
          { status }
        );
      } else {
        this.removeUnacknowledgedByType("bot_crash");
      }
    } catch {
      this.addAlert(
        "bot_crash",
        "critical",
        "Bot service status check failed",
        { error: "systemctl check failed" }
      );
    }
  }

  checkDiskSpace(): void {
    try {
      const output = execSync("df -h / | tail -1", {
        encoding: "utf-8",
        timeout: 5000,
      });
      const parts = output.trim().split(/\s+/);
      const percentStr = parts[4]?.replace("%", "");
      const percent = parseInt(percentStr || "0", 10);

      if (percent >= 90) {
        this.addAlert(
          "disk_space",
          "critical",
          `Disk usage at ${percent}%`,
          { used: parts[2], total: parts[1], percent }
        );
      } else if (percent >= 80) {
        this.addAlert(
          "disk_space",
          "warning",
          `Disk usage at ${percent}%`,
          { used: parts[2], total: parts[1], percent }
        );
      } else {
        this.removeUnacknowledgedByType("disk_space");
      }
    } catch {
      // Skip
    }
  }

  checkMemory(): void {
    try {
      const output = execSync("free -m", { encoding: "utf-8", timeout: 5000 });
      const line = output.split("\n")[1]?.split(/\s+/) || [];
      const total = parseInt(line[1] || "0", 10);
      const available = parseInt(line[6] || line[3] || "0", 10);

      if (total > 0) {
        const usedPercent = Math.round(((total - available) / total) * 100);
        if (usedPercent >= 95) {
          this.addAlert(
            "memory_high",
            "critical",
            `Memory usage at ${usedPercent}%`,
            { totalMB: total, availableMB: available, usedPercent }
          );
        } else if (usedPercent >= 85) {
          this.addAlert(
            "memory_high",
            "warning",
            `Memory usage at ${usedPercent}%`,
            { totalMB: total, availableMB: available, usedPercent }
          );
        } else {
          this.removeUnacknowledgedByType("memory_high");
        }
      }
    } catch {
      // Skip
    }
  }

  async checkErrorRate(): Promise<void> {
    try {
      const db = getDatabase(this.dataDir);
      const oneHourAgo = Date.now() - 60 * 60 * 1000;

      const row = db.prepare(`
        SELECT
          COUNT(*) as total,
          COUNT(CASE WHEN isError = 1 THEN 1 END) as errors
        FROM invocations
        WHERE timestamp >= ?
      `).get(oneHourAgo) as { total: number; errors: number } | undefined;

      if (row && row.total >= 5) {
        const errorRate = (row.errors / row.total) * 100;
        if (errorRate >= 20) {
          this.addAlert(
            "high_error_rate",
            "critical",
            `Error rate at ${errorRate.toFixed(0)}% in the last hour`,
            { errors: row.errors, total: row.total, errorRate }
          );
        } else if (errorRate >= 10) {
          this.addAlert(
            "high_error_rate",
            "warning",
            `Error rate at ${errorRate.toFixed(0)}% in the last hour`,
            { errors: row.errors, total: row.total, errorRate }
          );
        } else {
          this.removeUnacknowledgedByType("high_error_rate");
        }
      }
    } catch {
      // Skip
    }
  }

  // ── Public API ──

  getAlerts(includeAcknowledged: boolean = false): Alert[] {
    if (includeAcknowledged) return [...this.alerts];
    return this.alerts.filter((a) => !a.acknowledged);
  }

  acknowledgeAlert(id: string): boolean {
    const alert = this.alerts.find((a) => a.id === id);
    if (!alert) return false;
    alert.acknowledged = true;
    this.save().catch(() => {});
    return true;
  }

  getActiveAlertCount(): number {
    return this.alerts.filter((a) => !a.acknowledged).length;
  }
}
