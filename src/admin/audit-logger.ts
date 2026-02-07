import { getDatabase } from "../status/database.js";
import { logger } from "../utils/logger.js";

export interface AuditEntry {
  id?: number;
  timestamp: number;
  action: string;
  ip: string | null;
  details: string | null;
  username: string | null;
}

export class AuditLogger {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    // Ensure the audit_log table exists
    const db = getDatabase(dataDir);
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        action TEXT NOT NULL,
        ip TEXT,
        details TEXT,
        username TEXT
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)`);
    logger.info("Audit logger initialized");
  }

  log(entry: { action: string; ip?: string | null; details?: any; username?: string | null }): void {
    try {
      const db = getDatabase(this.dataDir);
      const stmt = db.prepare(`
        INSERT INTO audit_log (timestamp, action, ip, details, username)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(
        Date.now(),
        entry.action,
        entry.ip || null,
        entry.details ? (typeof entry.details === "string" ? entry.details : JSON.stringify(entry.details)) : null,
        entry.username || null,
      );
    } catch (err) {
      logger.error({ err }, "Failed to write audit log entry");
    }
  }

  getRecent(limit: number = 50): AuditEntry[] {
    const db = getDatabase(this.dataDir);
    return db.prepare(`
      SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as AuditEntry[];
  }

  getByAction(action: string, limit: number = 50): AuditEntry[] {
    const db = getDatabase(this.dataDir);
    return db.prepare(`
      SELECT * FROM audit_log WHERE action = ? ORDER BY timestamp DESC LIMIT ?
    `).all(action, limit) as AuditEntry[];
  }

  getByDateRange(from: number, to: number, limit: number = 200): AuditEntry[] {
    const db = getDatabase(this.dataDir);
    return db.prepare(`
      SELECT * FROM audit_log WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT ?
    `).all(from, to, limit) as AuditEntry[];
  }

  getActions(): string[] {
    const db = getDatabase(this.dataDir);
    const rows = db.prepare(`SELECT DISTINCT action FROM audit_log ORDER BY action`).all() as { action: string }[];
    return rows.map((r) => r.action);
  }
}
