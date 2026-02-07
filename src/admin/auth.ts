import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { logger } from "../utils/logger.js";

interface AdminData {
  username: string;
  passwordHash: string;
  mfaSecret: string | null;
  mfaEnabled: boolean;
  ipWhitelist: string[] | null;
}

export interface SessionInfo {
  jti: string;
  stage: "password" | "full";
  issuedAt: number;
  expiresAt: number;
  ip: string | null;
}

const SALT_ROUNDS = 12;

export class AdminAuth {
  private dataDir: string;
  private jwtSecret: string;
  private admin: AdminData | null = null;
  private activeSessions: Map<string, SessionInfo> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string, jwtSecret: string) {
    this.dataDir = dataDir;
    this.jwtSecret = jwtSecret;

    // Clean up expired sessions every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanupSessions(), 5 * 60 * 1000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  private get filePath(): string {
    return join(this.dataDir, "admin.json");
  }

  private get sessionsFilePath(): string {
    return join(this.dataDir, "admin-sessions.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const data = JSON.parse(raw);
      this.admin = {
        username: data.username,
        passwordHash: data.passwordHash,
        mfaSecret: data.mfaSecret ?? null,
        mfaEnabled: data.mfaEnabled ?? false,
        ipWhitelist: data.ipWhitelist ?? null,
      };
      logger.info("Admin config loaded");
    } catch {
      logger.info("No admin config found — setup required");
    }

    // Load persisted sessions
    await this.loadSessions();
  }

  private async loadSessions(): Promise<void> {
    try {
      const raw = await readFile(this.sessionsFilePath, "utf-8");
      const sessions: SessionInfo[] = JSON.parse(raw);
      const now = Date.now();
      let loaded = 0;
      for (const s of sessions) {
        // Only restore sessions that haven't expired
        if (s.expiresAt > now && s.jti) {
          this.activeSessions.set(s.jti, s);
          loaded++;
        }
      }
      if (loaded > 0) {
        logger.info({ count: loaded }, "Restored active admin sessions from disk");
      }
    } catch {
      // No persisted sessions file — that's fine
    }
  }

  private async saveSessions(): Promise<void> {
    try {
      await mkdir(join(this.sessionsFilePath, ".."), { recursive: true });
      const sessions = Array.from(this.activeSessions.values());
      await writeFile(this.sessionsFilePath, JSON.stringify(sessions, null, 2));
    } catch (err) {
      logger.error({ err }, "Failed to persist admin sessions");
    }
  }

  async save(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.admin, null, 2));
  }

  isSetUp(): boolean {
    return this.admin !== null;
  }

  isMfaEnabled(): boolean {
    return this.admin?.mfaEnabled ?? false;
  }

  async setup(username: string, password: string): Promise<void> {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    this.admin = {
      username,
      passwordHash,
      mfaSecret: null,
      mfaEnabled: false,
      ipWhitelist: null,
    };
    await this.save();
    logger.info({ username }, "Admin account created");
  }

  async verifyPassword(username: string, password: string): Promise<boolean> {
    if (!this.admin) return false;
    if (this.admin.username !== username) return false;
    return bcrypt.compare(password, this.admin.passwordHash);
  }

  setMfaSecret(secret: string): void {
    if (!this.admin) throw new Error("Admin not set up");
    this.admin.mfaSecret = secret;
  }

  getMfaSecret(): string | null {
    return this.admin?.mfaSecret ?? null;
  }

  async enableMfa(): Promise<void> {
    if (!this.admin) throw new Error("Admin not set up");
    if (!this.admin.mfaSecret) throw new Error("MFA secret not set");
    this.admin.mfaEnabled = true;
    await this.save();
    logger.info("MFA enabled");
  }

  async disableMfa(): Promise<void> {
    if (!this.admin) throw new Error("Admin not set up");
    this.admin.mfaSecret = null;
    this.admin.mfaEnabled = false;
    await this.save();
    logger.info("MFA disabled");
  }

  // ── Session Management ──

  generateToken(stage: "password" | "full", ip?: string | null): string {
    const jti = crypto.randomUUID();
    const expiresIn = stage === "password" ? "5m" : "24h";
    const expiresInMs = stage === "password" ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const now = Date.now();

    const token = jwt.sign({ stage, jti }, this.jwtSecret, { expiresIn });

    this.activeSessions.set(jti, {
      jti,
      stage,
      issuedAt: now,
      expiresAt: now + expiresInMs,
      ip: ip || null,
    });

    // Persist sessions to disk so they survive restarts
    this.saveSessions().catch(() => {});

    return token;
  }

  verifyToken(token: string): { stage: "password" | "full"; jti?: string } | null {
    try {
      const payload = jwt.verify(token, this.jwtSecret) as { stage: "password" | "full"; jti?: string };

      // If the token has a JTI, verify it's still in active sessions
      if (payload.jti) {
        if (!this.activeSessions.has(payload.jti)) {
          return null; // Session was revoked
        }
      }

      return payload;
    } catch {
      return null;
    }
  }

  getActiveSessions(): SessionInfo[] {
    this.cleanupSessions();
    return Array.from(this.activeSessions.values())
      .filter((s) => s.stage === "full") // Only show full sessions, not partial MFA ones
      .sort((a, b) => b.issuedAt - a.issuedAt);
  }

  revokeSession(jti: string): boolean {
    const existed = this.activeSessions.has(jti);
    this.activeSessions.delete(jti);
    if (existed) {
      logger.info({ jti }, "Admin session revoked");
      this.saveSessions().catch(() => {});
    }
    return existed;
  }

  revokeAllSessions(exceptJti?: string): number {
    let count = 0;
    for (const [jti] of this.activeSessions) {
      if (jti !== exceptJti) {
        this.activeSessions.delete(jti);
        count++;
      }
    }
    logger.info({ count, exceptJti }, "Revoked all admin sessions");
    this.saveSessions().catch(() => {});
    return count;
  }

  private cleanupSessions(): void {
    const now = Date.now();
    let removed = 0;
    for (const [jti, session] of this.activeSessions) {
      if (now >= session.expiresAt) {
        this.activeSessions.delete(jti);
        removed++;
      }
    }
    if (removed > 0) {
      this.saveSessions().catch(() => {});
    }
  }

  // ── IP Whitelisting ──

  getIpWhitelist(): string[] | null {
    return this.admin?.ipWhitelist ?? null;
  }

  async setIpWhitelist(ips: string[] | null): Promise<void> {
    if (!this.admin) throw new Error("Admin not set up");
    this.admin.ipWhitelist = ips;
    await this.save();
    logger.info({ ips }, "IP whitelist updated");
  }

  isIpAllowed(ip: string): boolean {
    const whitelist = this.admin?.ipWhitelist;
    if (!whitelist || whitelist.length === 0) return true; // Whitelist disabled
    // Normalize IPv6-mapped IPv4 addresses
    const normalized = ip.replace(/^::ffff:/, "");
    return whitelist.some((allowed) => {
      const normalizedAllowed = allowed.replace(/^::ffff:/, "");
      return normalizedAllowed === normalized || normalizedAllowed === ip;
    });
  }

  // ── Password ──

  async changePassword(newPassword: string): Promise<void> {
    if (!this.admin) throw new Error("Admin not set up");
    this.admin.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await this.save();
    logger.info("Admin password changed");
  }

  // ── Username ──

  getUsername(): string | null {
    return this.admin?.username ?? null;
  }

  async changeUsername(newUsername: string): Promise<void> {
    if (!this.admin) throw new Error("Admin not set up");
    const trimmed = newUsername.trim();
    if (!trimmed) throw new Error("Username cannot be empty");
    if (trimmed.length < 3) throw new Error("Username must be at least 3 characters");
    if (trimmed.length > 32) throw new Error("Username must be 32 characters or fewer");
    if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
      throw new Error("Username can only contain letters, numbers, underscores, dots, and hyphens");
    }
    this.admin.username = trimmed;
    await this.save();
    logger.info({ username: trimmed }, "Admin username changed");
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
