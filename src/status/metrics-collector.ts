import { execSync } from "child_process";
import { getDatabase } from "./database.js";
import { logger } from "../utils/logger.js";

export interface SystemMetric {
  id?: number;
  timestamp: number;
  cpuPercent: number;
  memUsedMB: number;
  memTotalMB: number;
  diskUsedPercent: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
}

export class MetricsCollector {
  private dataDir: string;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor(dataDir: string, intervalMs: number = 60000) {
    this.dataDir = dataDir;
    this.intervalMs = intervalMs;
  }

  private ensureTable(): void {
    if (this.initialized) return;
    const db = getDatabase(this.dataDir);
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        cpuPercent REAL DEFAULT 0,
        memUsedMB INTEGER DEFAULT 0,
        memTotalMB INTEGER DEFAULT 0,
        diskUsedPercent REAL DEFAULT 0,
        loadAvg1 REAL DEFAULT 0,
        loadAvg5 REAL DEFAULT 0,
        loadAvg15 REAL DEFAULT 0
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_system_metrics_timestamp ON system_metrics(timestamp)`);
    this.initialized = true;
    logger.info("System metrics table initialized");
  }

  start(): void {
    this.ensureTable();
    // Collect immediately, then on interval
    this.collectNow();
    this.timer = setInterval(() => this.collectNow(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    logger.info({ intervalMs: this.intervalMs }, "Metrics collector started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  collectNow(): void {
    try {
      this.ensureTable();
      const metric = this.gatherMetrics();
      const db = getDatabase(this.dataDir);

      db.prepare(`
        INSERT INTO system_metrics (timestamp, cpuPercent, memUsedMB, memTotalMB, diskUsedPercent, loadAvg1, loadAvg5, loadAvg15)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        metric.timestamp,
        metric.cpuPercent,
        metric.memUsedMB,
        metric.memTotalMB,
        metric.diskUsedPercent,
        metric.loadAvg1,
        metric.loadAvg5,
        metric.loadAvg15,
      );

      // Prune old metrics (keep last 7 days)
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      db.prepare(`DELETE FROM system_metrics WHERE timestamp < ?`).run(cutoff);
    } catch (err) {
      logger.error({ err }, "Failed to collect system metrics");
    }
  }

  private gatherMetrics(): SystemMetric {
    let cpuPercent = 0;
    let memUsedMB = 0;
    let memTotalMB = 0;
    let diskUsedPercent = 0;
    let loadAvg1 = 0;
    let loadAvg5 = 0;
    let loadAvg15 = 0;

    // CPU usage from /proc/stat snapshot (simplified — use load avg as proxy)
    try {
      const loadRaw = execSync("cat /proc/loadavg", { encoding: "utf-8", timeout: 3000 });
      const parts = loadRaw.trim().split(" ");
      loadAvg1 = parseFloat(parts[0]) || 0;
      loadAvg5 = parseFloat(parts[1]) || 0;
      loadAvg15 = parseFloat(parts[2]) || 0;

      // Estimate CPU % from 1-min load average vs CPU count
      const cpuCount = parseInt(
        execSync("nproc", { encoding: "utf-8", timeout: 3000 }).trim(),
        10
      ) || 1;
      cpuPercent = Math.min(100, Math.round((loadAvg1 / cpuCount) * 100));
    } catch {}

    // Memory
    try {
      const memRaw = execSync("free -m", { encoding: "utf-8", timeout: 3000 });
      const memLine = memRaw.split("\n")[1]?.split(/\s+/) || [];
      memTotalMB = parseInt(memLine[1] || "0", 10);
      const available = parseInt(memLine[6] || memLine[3] || "0", 10);
      memUsedMB = memTotalMB - available;
    } catch {}

    // Disk
    try {
      const diskRaw = execSync("df -h / | tail -1", { encoding: "utf-8", timeout: 3000 });
      const parts = diskRaw.trim().split(/\s+/);
      const percentStr = parts[4]?.replace("%", "");
      diskUsedPercent = parseFloat(percentStr || "0");
    } catch {}

    return {
      timestamp: Date.now(),
      cpuPercent,
      memUsedMB,
      memTotalMB,
      diskUsedPercent,
      loadAvg1,
      loadAvg5,
      loadAvg15,
    };
  }

  getMetrics(hours: number = 24): SystemMetric[] {
    this.ensureTable();
    const db = getDatabase(this.dataDir);
    const since = Date.now() - hours * 60 * 60 * 1000;
    return db.prepare(`
      SELECT * FROM system_metrics WHERE timestamp >= ? ORDER BY timestamp ASC
    `).all(since) as SystemMetric[];
  }
}
