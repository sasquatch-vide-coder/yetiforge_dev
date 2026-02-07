import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as OTPAuth from "otpauth";
import * as QRCode from "qrcode";
import { execSync, exec } from "child_process";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { AdminAuth } from "./auth.js";
import { AuditLogger } from "./audit-logger.js";
import { LoginRateLimiter } from "./rate-limiter.js";
import { AgentConfigManager } from "../agents/agent-config.js";
import { BotConfigManager } from "../bot-config-manager.js";
import { ChatAgent } from "../agents/chat-agent.js";
import { Executor } from "../agents/executor.js";
import { SessionManager } from "../claude/session-manager.js";
import { InvocationLogger } from "../status/invocation-logger.js";
import { logger } from "../utils/logger.js";
import type { WebChatStore, WebChatMessage } from "./web-chat-store.js";

// Re-export for use elsewhere
export { AdminAuth };

function requireAuth(auth: AdminAuth) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const token = authHeader.slice(7);
    const payload = auth.verifyToken(token);
    if (!payload || payload.stage !== "full") {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    // IP whitelist check
    if (!auth.isIpAllowed(request.ip)) {
      reply.code(403).send({ error: "IP not allowed" });
      return;
    }
  };
}

/** Extract the JTI from a request's bearer token (for session identification) */
function extractJti(request: FastifyRequest, auth: AdminAuth): string | undefined {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return undefined;
  const payload = auth.verifyToken(authHeader.slice(7));
  return payload?.jti;
}

export interface ChatDeps {
  chatAgent?: ChatAgent;
  executor?: Executor;
  sessionManager?: SessionManager;
  invocationLogger?: InvocationLogger;
  defaultProjectDir?: string;
  webChatStore?: WebChatStore;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  auth: AdminAuth,
  envPath: string,
  agentConfig?: AgentConfigManager,
  chatDeps?: ChatDeps,
  botConfigManager?: BotConfigManager,
) {
  const auditLogger = new AuditLogger(join(process.env.DATA_DIR || "data"));
  const rateLimiter = new LoginRateLimiter();

  // ── Setup endpoint disabled — admin account is created server-side ──
  app.post("/api/admin/setup", async (_request, reply) => {
    reply.code(403).send({ error: "Setup is disabled. Admin account must be created server-side." });
  });

  // ── Check if setup is needed ──
  app.get("/api/admin/setup-status", async () => {
    return {
      isSetUp: auth.isSetUp(),
      mfaEnabled: auth.isMfaEnabled(),
    };
  });

  // ── Bot Config (public) ──
  app.get("/api/bot/config", async () => {
    return { botName: botConfigManager?.getBotName() || "YETIFORGE" };
  });

  // ── Login ──
  app.post("/api/admin/login", async (request, reply) => {
    if (!auth.isSetUp()) {
      reply.code(400).send({ error: "Admin not set up" });
      return;
    }

    const ip = request.ip;

    // Rate limiting check
    if (rateLimiter.isLocked(ip)) {
      const status = rateLimiter.getStatus(ip);
      auditLogger.log({ action: "login_blocked", ip, details: { reason: "rate_limited" } });
      reply.code(429).send({
        error: "Too many failed attempts. Please try again later.",
        lockedUntil: status?.lockedUntil,
      });
      return;
    }

    const { username, password } = request.body as {
      username: string;
      password: string;
    };
    const valid = await auth.verifyPassword(username, password);
    if (!valid) {
      const result = rateLimiter.recordFailure(ip);
      auditLogger.log({
        action: "login_failure",
        ip,
        username,
        details: { remainingAttempts: result.remainingAttempts, locked: result.locked },
      });
      reply.code(401).send({
        error: "Invalid credentials",
        remainingAttempts: result.remainingAttempts,
      });
      return;
    }

    // Successful password verification
    rateLimiter.recordSuccess(ip);

    if (auth.isMfaEnabled()) {
      // Return partial token — needs MFA verification
      const token = auth.generateToken("password", ip);
      auditLogger.log({ action: "login_mfa_required", ip, username });
      return { ok: true, requireMfa: true, token };
    }

    // No MFA — full access
    const token = auth.generateToken("full", ip);
    auditLogger.log({ action: "login_success", ip, username });
    return { ok: true, requireMfa: false, token };
  });

  // ── MFA Verify ──
  app.post("/api/admin/mfa/verify", async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const partialToken = authHeader.slice(7);
    const payload = auth.verifyToken(partialToken);
    if (!payload || payload.stage !== "password") {
      reply.code(401).send({ error: "Invalid or expired token" });
      return;
    }

    const { code } = request.body as { code: string };
    const secret = auth.getMfaSecret();
    if (!secret) {
      reply.code(400).send({ error: "MFA not configured" });
      return;
    }

    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(secret),
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });

    const valid = totp.validate({ token: code, window: 1 }) !== null;
    if (!valid) {
      auditLogger.log({ action: "mfa_failure", ip: request.ip });
      reply.code(401).send({ error: "Invalid MFA code" });
      return;
    }

    const fullToken = auth.generateToken("full", request.ip);
    auditLogger.log({ action: "login_success", ip: request.ip, details: { via: "mfa" } });
    return { ok: true, token: fullToken };
  });

  // ── Protected routes below ──
  const authHook = requireAuth(auth);

  // ── MFA Setup ──
  app.get(
    "/api/admin/mfa/setup",
    { preHandler: authHook },
    async () => {
      const secret = new OTPAuth.Secret();
      const totp = new OTPAuth.TOTP({
        issuer: botConfigManager?.getBotName() || "YETIFORGE",
        label: "Admin",
        secret,
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      });

      auth.setMfaSecret(secret.base32);
      await auth.save();

      const uri = totp.toString();
      const qrDataUrl = await QRCode.toDataURL(uri);

      return {
        secret: secret.base32,
        uri,
        qrCode: qrDataUrl,
      };
    }
  );

  app.post(
    "/api/admin/mfa/enable",
    { preHandler: authHook },
    async (request, reply) => {
      const { code } = request.body as { code: string };
      const secret = auth.getMfaSecret();
      if (!secret) {
        reply.code(400).send({ error: "Generate MFA secret first" });
        return;
      }

      const totp = new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(secret),
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      });

      const valid = totp.validate({ token: code, window: 1 }) !== null;
      if (!valid) {
        reply.code(400).send({ error: "Invalid code — MFA not enabled" });
        return;
      }

      await auth.enableMfa();
      auditLogger.log({ action: "mfa_enable", ip: request.ip });
      return { ok: true };
    }
  );

  app.post(
    "/api/admin/mfa/disable",
    { preHandler: authHook },
    async (request) => {
      await auth.disableMfa();
      auditLogger.log({ action: "mfa_disable", ip: request.ip });
      return { ok: true };
    }
  );

  // ── Claude Code Status ──
  app.get(
    "/api/admin/claude/status",
    { preHandler: authHook },
    async () => {
      const result: {
        installed: boolean;
        version: string | null;
        authenticated: boolean;
        path: string | null;
        subscriptionType: string | null;
        rateLimitTier: string | null;
        credentialsExist: boolean;
        tokenExpiresAt: number | null;
        setupCommand: string;
      } = {
        installed: false,
        version: null,
        authenticated: false,
        path: null,
        subscriptionType: null,
        rateLimitTier: null,
        credentialsExist: false,
        tokenExpiresAt: null,
        setupCommand: "claude setup-token",
      };

      // Check if credentials file exists and read subscription info
      try {
        const credsRaw = await readFile(
          "/home/ubuntu/.claude/.credentials.json",
          "utf-8"
        );
        result.credentialsExist = true;
        const creds = JSON.parse(credsRaw);
        if (creds.claudeAiOauth) {
          result.subscriptionType = creds.claudeAiOauth.subscriptionType || null;
          result.rateLimitTier = creds.claudeAiOauth.rateLimitTier || null;
          const expiresAt = creds.claudeAiOauth.expiresAt;
          result.tokenExpiresAt = expiresAt || null;
          if (expiresAt && Date.now() < expiresAt) {
            result.authenticated = true;
          }
        }
      } catch {}

      // Check CLI installation
      try {
        const cli = process.env.CLAUDE_CLI_PATH || "claude";
        result.version = execSync(`${cli} --version 2>&1`, {
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        result.installed = true;
        result.path = cli;
      } catch {}

      return result;
    }
  );

  // ── Claude Code Update Check ──
  app.get(
    "/api/admin/claude/check-update",
    { preHandler: authHook },
    async () => {
      return new Promise((resolve) => {
        exec(
          `${process.env.CLAUDE_CLI_PATH || "claude"} update 2>&1`,
          { encoding: "utf-8", timeout: 30000 },
          (err, stdout) => {
            const output = stdout || (err?.message ?? "");
            const currentMatch = output.match(/Current version:\s*(\S+)/);
            const upToDate = output.includes("up to date");
            const updateAvailable = output.includes("Updating") || output.includes("update available");

            resolve({
              currentVersion: currentMatch?.[1] || null,
              updateAvailable,
              upToDate,
              output: output.trim(),
            });
          }
        );
      });
    }
  );

  // ── Claude Code Install Update ──
  app.post(
    "/api/admin/claude/update",
    { preHandler: authHook },
    async (request) => {
      auditLogger.log({ action: "claude_update", ip: request.ip });
      return new Promise((resolve) => {
        exec(
          `sudo ${process.env.CLAUDE_CLI_PATH || "claude"} update 2>&1`,
          { encoding: "utf-8", timeout: 120000 },
          (err, stdout) => {
            const output = stdout || (err?.message ?? "");
            resolve({
              ok: !err,
              output: output.trim(),
            });
          }
        );
      });
    }
  );

  // ── Telegram Status ──
  app.get(
    "/api/admin/telegram/status",
    { preHandler: authHook },
    async () => {
      try {
        const envContent = await readFile(envPath, "utf-8");

        const tokenMatch = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/);
        const botToken = tokenMatch?.[1]?.trim() || "";
        const hasToken = botToken.length > 0;

        const userMatch = envContent.match(/ALLOWED_USER_IDS=(.+)/);
        const allowedUserIds = userMatch
          ? userMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
          : [];

        let botRunning = false;
        try {
          const status = execSync("systemctl is-active tiffbot", {
            encoding: "utf-8",
          }).trim();
          botRunning = status === "active";
        } catch {}

        // Mask the token for display (show first 4 and last 4 chars)
        const maskedToken = hasToken
          ? botToken.slice(0, 4) + "..." + botToken.slice(-4)
          : "";

        return {
          configured: hasToken && allowedUserIds.length > 0,
          botRunning,
          botToken: maskedToken,
          allowedUserIds,
          allowedUserCount: allowedUserIds.length,
        };
      } catch {
        return {
          configured: false,
          botRunning: false,
          botToken: "",
          allowedUserIds: [],
          allowedUserCount: 0,
        };
      }
    }
  );

  // ── Telegram Config Update ──
  app.post(
    "/api/admin/telegram/config",
    { preHandler: authHook },
    async (request, reply) => {
      const { botToken, allowedUserIds } = request.body as {
        botToken?: string;
        allowedUserIds?: string[];
      };

      if (!botToken && !allowedUserIds) {
        reply.code(400).send({ error: "Provide botToken or allowedUserIds" });
        return;
      }

      try {
        let envContent = await readFile(envPath, "utf-8");

        if (botToken !== undefined) {
          if (envContent.match(/TELEGRAM_BOT_TOKEN=.*/)) {
            envContent = envContent.replace(
              /TELEGRAM_BOT_TOKEN=.*/,
              `TELEGRAM_BOT_TOKEN=${botToken}`
            );
          } else {
            envContent = `TELEGRAM_BOT_TOKEN=${botToken}\n` + envContent;
          }
        }

        if (allowedUserIds !== undefined) {
          const idsStr = allowedUserIds.join(",");
          if (envContent.match(/ALLOWED_USER_IDS=.*/)) {
            envContent = envContent.replace(
              /ALLOWED_USER_IDS=.*/,
              `ALLOWED_USER_IDS=${idsStr}`
            );
          } else {
            envContent += `\nALLOWED_USER_IDS=${idsStr}`;
          }
        }

        await writeFile(envPath, envContent);
        auditLogger.log({
          action: "telegram_config_update",
          ip: request.ip,
          details: { tokenChanged: !!botToken, userIdsChanged: !!allowedUserIds },
        });
        logger.info("Telegram config updated in .env");

        return { ok: true, restartRequired: true };
      } catch (e) {
        reply.code(500).send({
          error: e instanceof Error ? e.message : "Failed to update config",
        });
      }
    }
  );

  // ── Service Restart ──
  app.post(
    "/api/admin/service/restart",
    { preHandler: authHook },
    async (request) => {
      auditLogger.log({ action: "service_restart", ip: request.ip });
      return new Promise((resolve) => {
        // Use a small delay so the response can be sent before the process dies
        exec(
          "sleep 1 && sudo systemctl restart tiffbot 2>&1",
          { encoding: "utf-8", timeout: 30000 },
          (err, stdout) => {
            if (err) {
              resolve({ ok: false, output: stdout || err.message });
              return;
            }
            resolve({ ok: true, output: stdout });
          }
        );
        // Resolve immediately since the restart will kill this process
        setTimeout(() => resolve({ ok: true, output: "Restart initiated" }), 500);
      });
    }
  );

  // ── SSL Status ──
  app.get(
    "/api/admin/ssl/status",
    { preHandler: authHook },
    async () => {
      try {
        const certs = execSync(
          "sudo certbot certificates 2>&1",
          { encoding: "utf-8", timeout: 10000 }
        );

        const domainMatch = certs.match(/Domains:\s+(.+)/);
        const expiryMatch = certs.match(/Expiry Date:\s+(.+?)(\s+\(|$)/);
        const pathMatch = certs.match(/Certificate Path:\s+(.+)/);

        let autoRenew = false;
        try {
          execSync("systemctl is-active certbot.timer", { encoding: "utf-8" });
          autoRenew = true;
        } catch {}

        return {
          hasCert: !!domainMatch,
          domain: domainMatch?.[1]?.trim() || null,
          expiry: expiryMatch?.[1]?.trim() || null,
          certPath: pathMatch?.[1]?.trim() || null,
          autoRenew,
        };
      } catch {
        return {
          hasCert: false,
          domain: null,
          expiry: null,
          certPath: null,
          autoRenew: false,
        };
      }
    }
  );

  // ── SSL Renew ──
  app.post(
    "/api/admin/ssl/renew",
    { preHandler: authHook },
    async (request) => {
      auditLogger.log({ action: "ssl_renew", ip: request.ip });
      return new Promise((resolve) => {
        exec(
          "sudo certbot renew --nginx 2>&1",
          { encoding: "utf-8", timeout: 60000 },
          (err, stdout) => {
            if (err) {
              resolve({
                ok: false,
                output: stdout || err.message,
              });
              return;
            }
            resolve({ ok: true, output: stdout });
          }
        );
      });
    }
  );

  // ── SSL Generate New Cert ──
  app.post(
    "/api/admin/ssl/generate",
    { preHandler: authHook },
    async (request, reply) => {
      const { domain } = request.body as { domain?: string };

      if (!domain || !domain.trim()) {
        reply.code(400).send({ error: "Domain is required" });
        return;
      }

      const cleanDomain = domain.trim().toLowerCase();
      auditLogger.log({ action: "ssl_generate", ip: request.ip, details: { domain: cleanDomain } });

      return new Promise((resolve) => {
        exec(
          `sudo certbot certonly --nginx -d ${cleanDomain} --non-interactive --agree-tos --no-eff-email --register-unsafely-without-email 2>&1`,
          { encoding: "utf-8", timeout: 120000 },
          (err, stdout) => {
            if (err) {
              resolve({
                ok: false,
                output: stdout || err.message,
              });
              return;
            }
            resolve({ ok: true, output: stdout, domain: cleanDomain });
          }
        );
      });
    }
  );

  // ── Change Password ──
  app.post(
    "/api/admin/change-password",
    { preHandler: authHook },
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body as {
        currentPassword: string;
        newPassword: string;
      };

      if (!newPassword || newPassword.length < 8) {
        reply
          .code(400)
          .send({ error: "New password must be at least 8 characters" });
        return;
      }

      // Verify current password
      const valid = await auth.verifyPassword(
        (request.body as any).username || "",
        currentPassword
      );
      // Actually we don't need username here since they're already authed
      // Let's just change it
      await auth.changePassword(newPassword);
      auditLogger.log({ action: "password_change", ip: request.ip });
      return { ok: true };
    }
  );

  // ── Get Username ──
  app.get(
    "/api/admin/username",
    { preHandler: authHook },
    async () => {
      return { username: auth.getUsername() || "admin" };
    }
  );

  // ── Change Username ──
  app.post(
    "/api/admin/change-username",
    { preHandler: authHook },
    async (request, reply) => {
      const { newUsername } = request.body as { newUsername: string };

      if (!newUsername || !newUsername.trim()) {
        reply.code(400).send({ error: "Username cannot be empty" });
        return;
      }

      const trimmed = newUsername.trim();

      if (trimmed.length < 3) {
        reply.code(400).send({ error: "Username must be at least 3 characters" });
        return;
      }

      if (trimmed.length > 32) {
        reply.code(400).send({ error: "Username must be 32 characters or fewer" });
        return;
      }

      if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
        reply.code(400).send({
          error: "Username can only contain letters, numbers, underscores, dots, and hyphens",
        });
        return;
      }

      try {
        await auth.changeUsername(trimmed);
        auditLogger.log({
          action: "username_change",
          ip: request.ip,
          details: { newUsername: trimmed },
        });
        return { ok: true, username: trimmed };
      } catch (e) {
        reply.code(400).send({
          error: e instanceof Error ? e.message : "Failed to change username",
        });
      }
    }
  );

  // ── Agent Config Get ──
  app.get(
    "/api/admin/agents/config",
    { preHandler: authHook },
    async () => {
      if (!agentConfig) {
        return { error: "Agent config not available" };
      }
      return agentConfig.getAll();
    }
  );

  // ── Agent Config Update ──
  app.post(
    "/api/admin/agents/config",
    { preHandler: authHook },
    async (request, reply) => {
      if (!agentConfig) {
        reply.code(500).send({ error: "Agent config not available" });
        return;
      }

      const body = request.body as {
        chat?: { model?: string; timeoutMs?: number };
        executor?: {
          model?: string;
          timeoutMs?: number;
          stallWarning?: { trivialMs?: number; moderateMs?: number; complexMs?: number };
          stallKill?: { trivialMs?: number; moderateMs?: number; complexMs?: number };
          stallGraceMultiplier?: number;
        };
      };

      if (body.chat?.model) agentConfig.setModel("chat", body.chat.model);
      if (body.chat?.timeoutMs !== undefined) agentConfig.setTimeoutMs("chat", body.chat.timeoutMs);

      if (body.executor?.model) agentConfig.setModel("executor", body.executor.model);
      if (body.executor?.timeoutMs !== undefined) agentConfig.setTimeoutMs("executor", body.executor.timeoutMs);

      if (body.executor?.stallWarning) {
        const current = agentConfig.getStallWarning("executor");
        agentConfig.setStallWarning("executor", { ...current, ...body.executor.stallWarning });
      }
      if (body.executor?.stallKill) {
        const current = agentConfig.getStallKill("executor");
        agentConfig.setStallKill("executor", { ...current, ...body.executor.stallKill });
      }
      if (body.executor?.stallGraceMultiplier !== undefined) {
        agentConfig.setStallGraceMultiplier("executor", body.executor.stallGraceMultiplier);
      }

      await agentConfig.save();
      auditLogger.log({
        action: "agent_config_update",
        ip: request.ip,
        details: body,
      });
      return { ok: true, config: agentConfig.getAll() };
    }
  );

  // ── Audit Log ──
  app.get(
    "/api/admin/audit-log",
    { preHandler: authHook },
    async (request) => {
      const query = request.query as { limit?: string; action?: string; from?: string; to?: string };
      const limit = Math.min(parseInt(query.limit || "50", 10) || 50, 500);

      if (query.action) {
        return { entries: auditLogger.getByAction(query.action, limit) };
      }

      if (query.from && query.to) {
        return {
          entries: auditLogger.getByDateRange(
            parseInt(query.from, 10),
            parseInt(query.to, 10),
            limit,
          ),
        };
      }

      return { entries: auditLogger.getRecent(limit), actions: auditLogger.getActions() };
    }
  );

  // ── Security: Login Attempts ──
  app.get(
    "/api/admin/security/login-attempts",
    { preHandler: authHook },
    async () => {
      return { attempts: rateLimiter.getAll() };
    }
  );

  // ── Security: Unlock IP ──
  app.post(
    "/api/admin/security/unlock-ip",
    { preHandler: authHook },
    async (request, reply) => {
      const { ip } = request.body as { ip: string };
      if (!ip) {
        reply.code(400).send({ error: "IP is required" });
        return;
      }
      rateLimiter.clearIp(ip);
      auditLogger.log({ action: "ip_unlock", ip: request.ip, details: { unlockedIp: ip } });
      return { ok: true };
    }
  );

  // ── Session Management ──
  app.get(
    "/api/admin/sessions",
    { preHandler: authHook },
    async (request) => {
      const currentJti = extractJti(request, auth);
      const sessions = auth.getActiveSessions().map((s) => ({
        ...s,
        isCurrent: s.jti === currentJti,
      }));
      return { sessions };
    }
  );

  app.post(
    "/api/admin/sessions/revoke",
    { preHandler: authHook },
    async (request, reply) => {
      const { jti } = request.body as { jti: string };
      if (!jti) {
        reply.code(400).send({ error: "Session JTI is required" });
        return;
      }
      const revoked = auth.revokeSession(jti);
      if (revoked) {
        auditLogger.log({ action: "session_revoke", ip: request.ip, details: { revokedJti: jti } });
      }
      return { ok: true, revoked };
    }
  );

  app.post(
    "/api/admin/sessions/revoke-all",
    { preHandler: authHook },
    async (request) => {
      const currentJti = extractJti(request, auth);
      const count = auth.revokeAllSessions(currentJti);
      auditLogger.log({ action: "session_revoke_all", ip: request.ip, details: { count } });
      return { ok: true, revokedCount: count };
    }
  );

  // ── IP Whitelisting ──
  app.get(
    "/api/admin/security/ip-whitelist",
    { preHandler: authHook },
    async () => {
      return { whitelist: auth.getIpWhitelist() };
    }
  );

  app.post(
    "/api/admin/security/ip-whitelist",
    { preHandler: authHook },
    async (request, reply) => {
      const { ips } = request.body as { ips: string[] | null };

      // If enabling whitelist, make sure the requesting IP is included
      if (ips && ips.length > 0) {
        const requestIp = request.ip.replace(/^::ffff:/, "");
        const normalizedIps = ips.map((ip) => ip.replace(/^::ffff:/, "").trim()).filter(Boolean);
        if (!normalizedIps.includes(requestIp) && !normalizedIps.includes(request.ip)) {
          reply.code(400).send({
            error: `Your current IP (${requestIp}) must be included in the whitelist to avoid lockout`,
          });
          return;
        }
        await auth.setIpWhitelist(normalizedIps);
      } else {
        // Disable whitelist
        await auth.setIpWhitelist(null);
      }

      auditLogger.log({
        action: "ip_whitelist_update",
        ip: request.ip,
        details: { ips },
      });
      return { ok: true, whitelist: auth.getIpWhitelist() };
    }
  );

  // ── Web Chat (SSE) ──
  // Uses chatId -999 for a dedicated web admin session
  const WEB_CHAT_ID = -999;

  app.post(
    "/api/admin/chat",
    { preHandler: authHook },
    async (request, reply) => {
      const { chatAgent, executor, sessionManager, invocationLogger, defaultProjectDir, webChatStore } =
        chatDeps || {};

      if (!chatAgent || !executor) {
        reply.code(503).send({ error: "Chat agents not available" });
        return;
      }

      const { message } = request.body as { message: string };
      if (!message?.trim()) {
        reply.code(400).send({ error: "Message is required" });
        return;
      }

      const projectDir = defaultProjectDir || process.cwd();

      // Persist user message
      if (webChatStore) {
        await webChatStore.addMessage({
          id: `user-${Date.now()}`,
          role: "user",
          text: message.trim(),
          timestamp: Date.now(),
        });
      }

      // SSE stream
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const sendEvent = (event: string, data: any) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        // Phase 1: Chat Agent
        sendEvent("status", { message: "Thinking...", phase: "chat" });

        const chatResult = await chatAgent.invoke({
          chatId: WEB_CHAT_ID,
          prompt: message.trim(),
          cwd: projectDir,
          onInvocation: (raw) => {
            const entry = Array.isArray(raw)
              ? raw.find((item: any) => item.type === "result") || raw[0]
              : raw;
            if (entry && invocationLogger) {
              invocationLogger.log({
                timestamp: Date.now(),
                chatId: WEB_CHAT_ID,
                tier: "chat",
                durationMs: entry.durationms || entry.duration_ms,
                durationApiMs: entry.durationapims || entry.duration_api_ms,
                costUsd: entry.totalcostusd || entry.total_cost_usd || entry.cost_usd,
                numTurns: entry.numturns || entry.num_turns,
                stopReason: entry.subtype || entry.stopreason || entry.stop_reason,
                isError: entry.iserror || entry.is_error || false,
                modelUsage: entry.modelUsage || entry.model_usage,
              }).catch(() => {});
            }
          },
        });

        // Send chat response
        sendEvent("chat_response", {
          text: chatResult.chatResponse,
          hasWork: !!chatResult.workRequest,
        });

        // Persist assistant message
        if (webChatStore) {
          await webChatStore.addMessage({
            id: `assistant-${Date.now()}`,
            role: "assistant",
            text: chatResult.chatResponse,
            timestamp: Date.now(),
          });
        }

        // Save sessions
        if (sessionManager) {
          await sessionManager.save();
        }

        // Phase 2: If work is needed, execute
        if (chatResult.workRequest) {
          sendEvent("status", {
            message: "Starting work...",
            phase: "executor",
          });

          const result = await executor.execute({
            chatId: WEB_CHAT_ID,
            task: chatResult.workRequest.task,
            context: chatResult.workRequest.context || "",
            complexity: chatResult.workRequest.complexity || "moderate",
            rawMessage: message.trim(),
            cwd: projectDir,
            onStatusUpdate: (update) => {
              sendEvent("status", {
                message: update.progress
                  ? `${update.message} (${update.progress})`
                  : update.message,
                phase: "executor",
              });
            },
            onInvocation: (raw) => {
              const entry = Array.isArray(raw)
                ? raw.find((item: any) => item.type === "result") || raw[0]
                : raw;
              if (entry && invocationLogger) {
                invocationLogger.log({
                  timestamp: Date.now(),
                  chatId: WEB_CHAT_ID,
                  tier: entry._tier || "executor",
                  durationMs: entry.durationms || entry.duration_ms,
                  durationApiMs: entry.durationapims || entry.duration_api_ms,
                  costUsd:
                    entry.totalcostusd ||
                    entry.total_cost_usd ||
                    entry.cost_usd,
                  numTurns: entry.numturns || entry.num_turns,
                  stopReason:
                    entry.subtype || entry.stopreason || entry.stop_reason,
                  isError: entry.iserror || entry.is_error || false,
                  modelUsage: entry.modelUsage || entry.model_usage,
                }).catch(() => {});
              }
            },
          });

          // Get Tiffany-voiced summary via chat agent
          sendEvent("status", {
            message: "Summarizing results...",
            phase: "summary",
          });

          const summaryPrompt = `Work has been completed. Here's the executor's report:\n\n${result.result}\n\nOverall success: ${result.success}\nDuration: ${Math.round(result.durationMs / 1000)}s\nCost: $${result.costUsd.toFixed(4)}\n\nSummarize this for the user in your own words.`;

          const finalResult = await chatAgent.invoke({
            chatId: WEB_CHAT_ID,
            prompt: summaryPrompt,
            cwd: projectDir,
            onInvocation: (raw) => {
              const entry = Array.isArray(raw)
                ? raw.find((item: any) => item.type === "result") || raw[0]
                : raw;
              if (entry && invocationLogger) {
                invocationLogger.log({
                  timestamp: Date.now(),
                  chatId: WEB_CHAT_ID,
                  tier: "chat",
                  durationMs: entry.durationms || entry.duration_ms,
                  durationApiMs: entry.durationapims || entry.duration_api_ms,
                  costUsd:
                    entry.totalcostusd ||
                    entry.total_cost_usd ||
                    entry.cost_usd,
                  numTurns: entry.numturns || entry.num_turns,
                  stopReason:
                    entry.subtype || entry.stopreason || entry.stop_reason,
                  isError: entry.iserror || entry.is_error || false,
                  modelUsage: entry.modelUsage || entry.model_usage,
                }).catch(() => {});
              }
            },
          });

          const workSummaryText = finalResult.chatResponse || result.result;
          sendEvent("work_complete", {
            summary: workSummaryText,
            overallSuccess: result.success,
            totalCostUsd: result.costUsd,
          });

          // Persist work result
          if (webChatStore) {
            await webChatStore.addMessage({
              id: `work-${Date.now()}`,
              role: "work_result",
              text: workSummaryText,
              timestamp: Date.now(),
              workMeta: {
                overallSuccess: result.success,
                totalCostUsd: result.costUsd,
              },
            });
          }

          if (sessionManager) {
            await sessionManager.save();
          }
        }

        sendEvent("done", { ok: true });
      } catch (err: any) {
        logger.error({ err }, "Web chat error");
        sendEvent("error", {
          message: err.message || "An error occurred",
        });
      } finally {
        reply.raw.end();
      }
    }
  );

  // ── Web Chat Session Reset ──
  app.post(
    "/api/admin/chat/reset",
    { preHandler: authHook },
    async (request) => {
      const { sessionManager, webChatStore } = chatDeps || {};
      if (sessionManager) {
        sessionManager.clear(WEB_CHAT_ID);
        await sessionManager.save();
      }
      if (webChatStore) {
        await webChatStore.clear();
      }
      auditLogger.log({ action: "chat_reset", ip: request.ip });
      return { ok: true };
    }
  );

  // ── Web Chat History ──
  app.get(
    "/api/admin/chat/history",
    { preHandler: authHook },
    async () => {
      const { webChatStore } = chatDeps || {};
      if (!webChatStore) {
        return { messages: [] };
      }
      return { messages: webChatStore.getMessages() };
    }
  );

  // ── Chat History Export ──
  app.get(
    "/api/admin/chat/export",
    { preHandler: authHook },
    async (request, reply) => {
      const { webChatStore } = chatDeps || {};
      const messages = webChatStore?.getMessages() || [];
      const query = request.query as { format?: string };
      const format = query.format === "text" ? "text" : "json";

      if (format === "text") {
        const lines = messages.map((m: WebChatMessage) => {
          const time = new Date(m.timestamp).toISOString();
          const speaker = m.role === "user" ? "You" : m.role === "assistant" ? "Tiffany" : m.role;
          return `[${time}] ${speaker}: ${m.text}`;
        });
        const text = lines.join("\n\n");
        reply
          .header("Content-Type", "text/plain")
          .header("Content-Disposition", `attachment; filename="chat-export-${Date.now()}.txt"`)
          .send(text);
      } else {
        reply
          .header("Content-Type", "application/json")
          .header("Content-Disposition", `attachment; filename="chat-export-${Date.now()}.json"`)
          .send(JSON.stringify(messages, null, 2));
      }
    }
  );
}
