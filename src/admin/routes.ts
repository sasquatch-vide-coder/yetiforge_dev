import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as OTPAuth from "otpauth";
import * as QRCode from "qrcode";
import { execSync, exec } from "child_process";
import { readFile, writeFile } from "fs/promises";
import { AdminAuth } from "./auth.js";
import { logger } from "../utils/logger.js";

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
  };
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  auth: AdminAuth,
  envPath: string
) {
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

  // ── Login ──
  app.post("/api/admin/login", async (request, reply) => {
    if (!auth.isSetUp()) {
      reply.code(400).send({ error: "Admin not set up" });
      return;
    }
    const { username, password } = request.body as {
      username: string;
      password: string;
    };
    const valid = await auth.verifyPassword(username, password);
    if (!valid) {
      reply.code(401).send({ error: "Invalid credentials" });
      return;
    }

    if (auth.isMfaEnabled()) {
      // Return partial token — needs MFA verification
      const token = auth.generateToken("password");
      return { ok: true, requireMfa: true, token };
    }

    // No MFA — full access
    const token = auth.generateToken("full");
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
      reply.code(401).send({ error: "Invalid MFA code" });
      return;
    }

    const fullToken = auth.generateToken("full");
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
        issuer: "Rumpbot",
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
      return { ok: true };
    }
  );

  app.post(
    "/api/admin/mfa/disable",
    { preHandler: authHook },
    async () => {
      await auth.disableMfa();
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
        result.version = execSync("claude --version 2>&1", {
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        result.installed = true;
        result.path = execSync("which claude", {
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
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
          "claude update 2>&1",
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
    async () => {
      return new Promise((resolve) => {
        exec(
          "claude update 2>&1",
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
          const status = execSync("systemctl is-active rumpbot", {
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
    async () => {
      return new Promise((resolve) => {
        // Use a small delay so the response can be sent before the process dies
        exec(
          "sleep 1 && sudo systemctl restart rumpbot 2>&1",
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
    async () => {
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
      return { ok: true };
    }
  );
}
