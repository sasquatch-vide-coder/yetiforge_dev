import { logger } from "../utils/logger.js";

export interface RateLimitEntry {
  attempts: number;
  firstAttemptAt: number;
  lockedUntil: number | null;
}

export interface RateLimitResult {
  locked: boolean;
  remainingAttempts: number;
  lockedUntil?: number;
}

export class LoginRateLimiter {
  private attempts: Map<string, RateLimitEntry> = new Map();
  private maxAttempts: number;
  private windowMs: number;
  private lockoutMs: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(opts?: { maxAttempts?: number; windowMs?: number; lockoutMs?: number }) {
    this.maxAttempts = opts?.maxAttempts ?? 5;
    this.windowMs = opts?.windowMs ?? 15 * 60 * 1000; // 15 min
    this.lockoutMs = opts?.lockoutMs ?? 30 * 60 * 1000; // 30 min

    // Cleanup expired entries every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    // Allow process to exit even if timer is running
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  isLocked(ip: string): boolean {
    const entry = this.attempts.get(ip);
    if (!entry) return false;
    if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true;
    // If lockout has expired, clear it
    if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
      this.attempts.delete(ip);
      return false;
    }
    return false;
  }

  recordFailure(ip: string): RateLimitResult {
    const now = Date.now();
    let entry = this.attempts.get(ip);

    if (!entry || (now - entry.firstAttemptAt > this.windowMs)) {
      // Start a new window
      entry = { attempts: 1, firstAttemptAt: now, lockedUntil: null };
      this.attempts.set(ip, entry);
    } else {
      entry.attempts++;
    }

    if (entry.attempts >= this.maxAttempts) {
      entry.lockedUntil = now + this.lockoutMs;
      logger.warn({ ip, attempts: entry.attempts }, "IP locked out due to too many failed login attempts");
      return {
        locked: true,
        remainingAttempts: 0,
        lockedUntil: entry.lockedUntil,
      };
    }

    return {
      locked: false,
      remainingAttempts: this.maxAttempts - entry.attempts,
    };
  }

  recordSuccess(ip: string): void {
    this.attempts.delete(ip);
  }

  getStatus(ip: string): RateLimitEntry | null {
    return this.attempts.get(ip) || null;
  }

  getAll(): Record<string, RateLimitEntry & { currentlyLocked: boolean }> {
    const result: Record<string, RateLimitEntry & { currentlyLocked: boolean }> = {};
    const now = Date.now();
    for (const [ip, entry] of this.attempts) {
      result[ip] = {
        ...entry,
        currentlyLocked: !!(entry.lockedUntil && now < entry.lockedUntil),
      };
    }
    return result;
  }

  clearIp(ip: string): void {
    this.attempts.delete(ip);
    logger.info({ ip }, "IP manually unlocked");
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.attempts) {
      // Remove entries whose window has expired and are not locked
      if (!entry.lockedUntil && now - entry.firstAttemptAt > this.windowMs) {
        this.attempts.delete(ip);
      }
      // Remove entries whose lockout has expired
      if (entry.lockedUntil && now >= entry.lockedUntil) {
        this.attempts.delete(ip);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
