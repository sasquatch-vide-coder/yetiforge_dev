import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFile } from "fs/promises";
import { execSync, exec } from "child_process";
import { logger } from "../utils/logger.js";
import { AdminAuth } from "../admin/auth.js";
import { registerAdminRoutes } from "../admin/routes.js";
import { AgentConfigManager } from "../agents/agent-config.js";
import { BotConfigManager } from "../bot-config-manager.js";
import { AgentRegistry } from "../agents/agent-registry.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { ChatAgent } from "../agents/chat-agent.js";
import { Executor } from "../agents/executor.js";
import { SessionManager } from "../claude/session-manager.js";
import { InvocationLogger } from "./invocation-logger.js";
import { WebChatStore } from "../admin/web-chat-store.js";
import { getAllInvocations, getInvocationStats, getDailyStats } from "./database.js";
import { WebhookManager } from "../webhook-manager.js";
import { MetricsCollector } from "./metrics-collector.js";
import { AlertManager } from "../admin/alert-manager.js";
import { ConfigHistory } from "../admin/config-history.js";
import { BackupManager } from "../admin/backup-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SessionData {
  sessionId: string;
  projectDir: string;
  lastUsedAt: number;
}

interface ProjectsData {
  projects: Record<string, string>;
  activeProject: Record<string, string>;
}

function getServiceStatusByName(serviceName: string): {
  status: string;
  uptime: string | null;
  pid: number | null;
  memory: string | null;
} {
  try {
    const raw = execSync(`systemctl show ${serviceName} --no-pager`, {
      encoding: "utf-8",
    });
    const props: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        props[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }

    const activeState = props["ActiveState"] || "unknown";
    const pid = props["MainPID"] ? parseInt(props["MainPID"], 10) : null;

    let uptime: string | null = null;
    if (props["ActiveEnterTimestamp"]) {
      const entered = new Date(props["ActiveEnterTimestamp"]);
      if (!isNaN(entered.getTime())) {
        const diffMs = Date.now() - entered.getTime();
        uptime = formatDuration(diffMs);
      }
    }

    let memory: string | null = null;
    if (pid && pid > 0) {
      try {
        const rss = execSync(`ps -o rss= -p ${pid}`, {
          encoding: "utf-8",
        }).trim();
        const kb = parseInt(rss, 10);
        if (!isNaN(kb)) {
          memory = `${(kb / 1024).toFixed(1)} MB`;
        }
      } catch {}
    }

    return { status: activeState, uptime, pid, memory };
  } catch {
    return { status: "unknown", uptime: null, pid: null, memory: null };
  }
}

function getServiceStatus() {
  return getServiceStatusByName("tiffbot");
}

function getNginxStatus() {
  return getServiceStatusByName("nginx");
}

function getSystemInfo(): {
  serverUptime: string;
  loadAvg: number[];
  totalMemMB: number;
  freeMemMB: number;
  diskUsed: string;
  diskTotal: string;
  diskPercent: string;
} {
  try {
    const uptimeSeconds = parseFloat(
      execSync("cat /proc/uptime", { encoding: "utf-8" }).split(" ")[0]
    );
    const loadAvgRaw = execSync("cat /proc/loadavg", {
      encoding: "utf-8",
    }).split(" ");
    const memRaw = execSync("free -m", { encoding: "utf-8" });
    const memLine = memRaw.split("\n")[1]?.split(/\s+/) || [];
    const diskRaw = execSync("df -h / | tail -1", {
      encoding: "utf-8",
    }).split(/\s+/);

    return {
      serverUptime: formatDuration(uptimeSeconds * 1000),
      loadAvg: loadAvgRaw.slice(0, 3).map(Number),
      totalMemMB: parseInt(memLine[1] || "0", 10),
      freeMemMB: parseInt(memLine[6] || memLine[3] || "0", 10),
      diskUsed: diskRaw[2] || "?",
      diskTotal: diskRaw[1] || "?",
      diskPercent: diskRaw[4] || "?",
    };
  } catch {
    return {
      serverUptime: "unknown",
      loadAvg: [0, 0, 0],
      totalMemMB: 0,
      freeMemMB: 0,
      diskUsed: "?",
      diskTotal: "?",
      diskPercent: "?",
    };
  }
}

async function getSessions(
  dataDir: string
): Promise<Record<string, SessionData>> {
  try {
    const raw = await readFile(join(dataDir, "sessions.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function getProjects(dataDir: string): Promise<ProjectsData> {
  try {
    const raw = await readFile(join(dataDir, "projects.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { projects: {}, activeProject: {} };
  }
}

function getRecentLogs(lines: number = 50): Promise<string[]> {
  return new Promise((resolve) => {
    exec(
      `journalctl -u tiffbot --no-pager -n ${lines} --output=short-iso`,
      { encoding: "utf-8" },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        resolve(
          stdout
            .split("\n")
            .filter((l) => l.trim().length > 0)
        );
      }
    );
  });
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(" ");
}

export async function startStatusServer(dataDir: string, port: number = 3069, config?: { adminJwtSecret: string; agentConfig?: AgentConfigManager; agentRegistry?: AgentRegistry; botConfigManager?: BotConfigManager; chatAgent?: ChatAgent; executor?: Executor; sessionManager?: SessionManager; invocationLogger?: InvocationLogger; defaultProjectDir?: string; webhookManager?: WebhookManager }) {
  const app = Fastify({ logger: false, trustProxy: true });

  await app.register(fastifyCors, { origin: true });

  // Admin auth
  const adminAuth = new AdminAuth(dataDir, config?.adminJwtSecret || "yetiforge-admin-default-secret");
  await adminAuth.load();

  // Web chat persistence
  const webChatStore = new WebChatStore(dataDir);
  await webChatStore.load();

  // ── New managers ──
  const metricsCollector = new MetricsCollector(dataDir, 60000);
  metricsCollector.start();

  const alertManager = new AlertManager(dataDir);
  await alertManager.load();
  alertManager.startMonitoring(5 * 60 * 1000);

  const configHistory = new ConfigHistory(dataDir);
  await configHistory.load();

  const backupManager = new BackupManager(dataDir);

  const envPath = join(process.cwd(), ".env");
  await registerAdminRoutes(app, adminAuth, envPath, config?.agentConfig, {
    chatAgent: config?.chatAgent,
    executor: config?.executor,
    sessionManager: config?.sessionManager,
    invocationLogger: config?.invocationLogger,
    defaultProjectDir: config?.defaultProjectDir,
    webChatStore,
  }, config?.botConfigManager);

  // UI static files are now served directly by Nginx — Fastify is API-only

  // Auth middleware for API routes
  const requireAuth = async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    const token = authHeader.slice(7);
    const payload = adminAuth.verifyToken(token);
    if (!payload || payload.stage !== "full") {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    // IP whitelist check (consistent with admin routes)
    if (!adminAuth.isIpAllowed(request.ip)) {
      reply.code(403).send({ error: "IP not allowed" });
      return;
    }
  };

  // API routes (all require auth)
  app.get("/api/status", { preHandler: requireAuth }, async () => {
    const [tiffbotStatus, nginxStatus, system, sessions, projects] = await Promise.all([
      getServiceStatus(),
      getNginxStatus(),
      getSystemInfo(),
      getSessions(dataDir),
      getProjects(dataDir),
    ]);

    const sessionCount = Object.keys(sessions).length;
    const lastActivity = Object.values(sessions).reduce(
      (max, s) => Math.max(max, s.lastUsedAt || 0),
      0
    );

    return {
      timestamp: Date.now(),
      service: tiffbotStatus,
      services: {
        tiffbot: tiffbotStatus,
        nginx: nginxStatus,
      },
      system,
      bot: {
        sessionCount,
        lastActivity: lastActivity > 0 ? lastActivity : null,
        sessions: Object.entries(sessions).map(([chatId, s]) => ({
          chatId,
          projectDir: s.projectDir,
          lastUsedAt: s.lastUsedAt,
        })),
      },
      projects: {
        registered: Object.keys(projects.projects).length,
        list: projects.projects,
        activeProject: projects.activeProject,
      },
    };
  });

  app.get("/api/invocations", { preHandler: requireAuth }, async () => {
    try {
      const rows = getAllInvocations(dataDir);
      // Convert rows to the format expected by the dashboard
      const invocations = rows.map((row) => ({
        timestamp: row.timestamp,
        chatId: row.chatId,
        tier: row.tier,
        durationMs: row.durationMs,
        durationApiMs: row.durationApiMs,
        costUsd: row.costUsd,
        numTurns: row.numTurns,
        stopReason: row.stopReason,
        isError: row.isError === 1 || row.isError === true,
        modelUsage: row.modelUsage ? JSON.parse(row.modelUsage as string) : undefined,
      }));
      return { invocations };
    } catch (err) {
      logger.error({ err }, "Failed to read invocations from SQLite");
      return { invocations: [] };
    }
  });

  app.get("/api/lifetime-stats", { preHandler: requireAuth }, async () => {
    try {
      const stats = getInvocationStats(dataDir);
      return stats;
    } catch (err) {
      logger.error({ err }, "Failed to get invocation stats from SQLite");
      return { error: "Failed to get stats" };
    }
  });

  app.get("/api/stats", { preHandler: requireAuth }, async () => {
    try {
      const stats = getInvocationStats(dataDir);
      const rows = getAllInvocations(dataDir);

      // Compute additional aggregate stats
      const avgCost = stats.totalInvocations > 0 ? stats.totalCost / stats.totalInvocations : 0;
      const totalDurationMs = rows.reduce((sum, r) => sum + (r.durationMs || 0), 0);
      const avgDurationMs = stats.totalInvocations > 0 ? totalDurationMs / stats.totalInvocations : 0;
      const errors = rows.filter((r) => r.isError === 1 || r.isError === true).length;

      // Costs by tier
      const costsByTier: Record<string, { count: number; cost: number }> = {};
      for (const row of rows) {
        const tier = row.tier || "unknown";
        if (!costsByTier[tier]) costsByTier[tier] = { count: 0, cost: 0 };
        costsByTier[tier].count++;
        costsByTier[tier].cost += row.costUsd || 0;
      }

      // Duration percentiles (p50, p95)
      const durations = rows
        .map((r) => r.durationMs || 0)
        .filter((d) => d > 0)
        .sort((a, b) => a - b);

      let p50DurationMs = 0;
      let p95DurationMs = 0;
      if (durations.length > 0) {
        const p50Idx = Math.floor(durations.length * 0.5);
        const p95Idx = Math.floor(durations.length * 0.95);
        p50DurationMs = durations[Math.min(p50Idx, durations.length - 1)];
        p95DurationMs = durations[Math.min(p95Idx, durations.length - 1)];
      }

      return {
        ...stats,
        avgCost,
        avgDurationMs,
        totalDurationMs,
        p50DurationMs,
        p95DurationMs,
        errors,
        costsByTier,
      };
    } catch (err) {
      logger.error({ err }, "Failed to get stats from SQLite");
      return { error: "Failed to get stats" };
    }
  });

  // GET /api/stats/models — per-model aggregated stats
  app.get("/api/stats/models", { preHandler: requireAuth }, async () => {
    try {
      const rows = getAllInvocations(dataDir);
      const modelAgg: Record<string, { count: number; cost: number; tokens: number }> = {};

      for (const row of rows) {
        const usage = row.modelUsage ? JSON.parse(row.modelUsage as string) : null;
        if (!usage || typeof usage !== "object") continue;

        const models = Object.keys(usage);
        if (models.length === 0) continue;

        const perModelTokens: Record<string, number> = {};
        let invocationTotalTokens = 0;
        for (const model of models) {
          const m = usage[model];
          const mTokens =
            (m.inputTokens || 0) +
            (m.outputTokens || 0) +
            (m.cacheReadInputTokens || 0) +
            (m.cacheCreationInputTokens || 0);
          perModelTokens[model] = mTokens;
          invocationTotalTokens += mTokens;
        }

        const invocationCost = row.costUsd || 0;

        for (const model of models) {
          if (!modelAgg[model]) modelAgg[model] = { count: 0, cost: 0, tokens: 0 };
          modelAgg[model].count++;
          modelAgg[model].tokens += perModelTokens[model];

          if (invocationTotalTokens > 0) {
            modelAgg[model].cost += invocationCost * (perModelTokens[model] / invocationTotalTokens);
          } else if (models.length > 0) {
            modelAgg[model].cost += invocationCost / models.length;
          }
        }
      }

      const result = Object.entries(modelAgg)
        .map(([model, data]) => ({
          model,
          count: data.count,
          cost: Math.round(data.cost * 1000000) / 1000000,
          tokens: data.tokens,
        }))
        .sort((a, b) => b.cost - a.cost);

      return result;
    } catch (err) {
      logger.error({ err }, "Failed to get model stats from SQLite");
      return [];
    }
  });

  app.get("/api/stats/daily", { preHandler: requireAuth }, async () => {
    try {
      const daily = getDailyStats(dataDir);
      return daily;
    } catch (err) {
      logger.error({ err }, "Failed to get daily stats from SQLite");
      return [];
    }
  });

  // ── Per-tier stats ──
  app.get("/api/stats/tiers", { preHandler: requireAuth }, async () => {
    try {
      const rows = getAllInvocations(dataDir);
      const tierStats: Record<string, {
        count: number;
        totalCost: number;
        durations: number[];
        errorCount: number;
        totalInputTokens: number;
        totalOutputTokens: number;
      }> = {};

      for (const row of rows) {
        const tier = row.tier || "unknown";
        if (!tierStats[tier]) {
          tierStats[tier] = {
            count: 0, totalCost: 0, durations: [], errorCount: 0,
            totalInputTokens: 0, totalOutputTokens: 0,
          };
        }
        const t = tierStats[tier];
        t.count++;
        t.totalCost += row.costUsd || 0;
        if (row.durationMs) t.durations.push(row.durationMs);
        if (row.isError === 1 || row.isError === true) t.errorCount++;
        t.totalInputTokens += (row.inputTokens || 0);
        t.totalOutputTokens += (row.outputTokens || 0);
      }

      const result: Record<string, any> = {};
      for (const [tier, t] of Object.entries(tierStats)) {
        const sorted = t.durations.sort((a, b) => a - b);
        const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0;
        const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;
        result[tier] = {
          count: t.count,
          totalCost: Math.round(t.totalCost * 10000) / 10000,
          avgCost: t.count > 0 ? Math.round((t.totalCost / t.count) * 10000) / 10000 : 0,
          avgDurationMs: t.count > 0 ? Math.round(t.durations.reduce((s, d) => s + d, 0) / t.count) : 0,
          p50DurationMs: p50,
          p95DurationMs: p95,
          errorCount: t.errorCount,
          errorRate: t.count > 0 ? Math.round((t.errorCount / t.count) * 1000) / 10 : 0,
          totalInputTokens: t.totalInputTokens,
          totalOutputTokens: t.totalOutputTokens,
        };
      }

      return result;
    } catch (err) {
      logger.error({ err }, "Failed to get tier stats");
      return {};
    }
  });

  // ── System metrics (historical) ──
  app.get("/api/stats/system", { preHandler: requireAuth }, async (request) => {
    const query = request.query as { hours?: string };
    const hours = Math.min(parseInt(query.hours || "24", 10) || 24, 168); // max 7 days
    return { metrics: metricsCollector.getMetrics(hours) };
  });

  // ── Invocations CSV export ──
  app.get("/api/stats/export", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const rows = getAllInvocations(dataDir);
      const headers = ["timestamp", "chatId", "tier", "durationMs", "costUsd", "numTurns", "stopReason", "isError", "inputTokens", "outputTokens"];
      const csvLines = [headers.join(",")];

      for (const row of rows) {
        csvLines.push([
          row.timestamp,
          row.chatId,
          row.tier || "",
          row.durationMs || 0,
          row.costUsd || 0,
          row.numTurns || 0,
          row.stopReason || "",
          row.isError ? 1 : 0,
          row.inputTokens || 0,
          row.outputTokens || 0,
        ].join(","));
      }

      reply
        .header("Content-Type", "text/csv")
        .header("Content-Disposition", `attachment; filename="invocations-${Date.now()}.csv"`)
        .send(csvLines.join("\n"));
    } catch (err) {
      logger.error({ err }, "Failed to export invocations");
      reply.code(500).send({ error: "Export failed" });
    }
  });

  // ── Alerts ──
  app.get("/api/admin/alerts", { preHandler: requireAuth }, async (request) => {
    const query = request.query as { all?: string };
    const includeAcknowledged = query.all === "true";
    return { alerts: alertManager.getAlerts(includeAcknowledged) };
  });

  app.post("/api/admin/alerts/:id/acknowledge", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = alertManager.acknowledgeAlert(id);
    if (!ok) {
      reply.code(404).send({ error: "Alert not found" });
      return;
    }
    return { ok: true };
  });

  app.get("/api/admin/alerts/count", { preHandler: requireAuth }, async () => {
    return { count: alertManager.getActiveAlertCount() };
  });

  // ── Config History ──
  app.get("/api/admin/config/history", { preHandler: requireAuth }, async (request) => {
    const query = request.query as { type?: string };
    if (!query.type) {
      return { error: "Query param 'type' is required (agent, telegram, bot)" };
    }
    return { history: configHistory.getHistory(query.type) };
  });

  app.post("/api/admin/config/rollback", { preHandler: requireAuth }, async (request, reply) => {
    const { type, snapshotId } = request.body as { type: string; snapshotId: string };
    if (!type || !snapshotId) {
      reply.code(400).send({ error: "type and snapshotId are required" });
      return;
    }

    const snapshot = configHistory.getSnapshot(type, snapshotId);
    if (!snapshot) {
      reply.code(404).send({ error: "Snapshot not found" });
      return;
    }

    // Apply the rollback based on config type
    if (type === "agent" && config?.agentConfig) {
      const data = snapshot.data;
      for (const tier of ["chat", "executor"] as const) {
        if (data[tier]) {
          if (data[tier].model) config.agentConfig.setModel(tier, data[tier].model);
          if (data[tier].timeoutMs !== undefined) config.agentConfig.setTimeoutMs(tier, data[tier].timeoutMs);
        }
      }
      await config.agentConfig.save();
    } else if (type === "bot" && config?.botConfigManager) {
      if (snapshot.data.botName) {
        config.botConfigManager.setBotName(snapshot.data.botName);
        await config.botConfigManager.save();
      }
    }

    return { ok: true, restoredTo: snapshotId };
  });

  // ── Backup & Restore ──
  app.post("/api/admin/backup/create", { preHandler: requireAuth }, async () => {
    try {
      const info = await backupManager.createBackup();
      return { ok: true, backup: info };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  app.get("/api/admin/backup/list", { preHandler: requireAuth }, async () => {
    const backups = await backupManager.listBackups();
    return { backups };
  });

  app.post("/api/admin/backup/restore", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.body as { id: string };
    if (!id) {
      reply.code(400).send({ error: "Backup id is required" });
      return;
    }
    try {
      const result = await backupManager.restoreBackup(id);
      return { ok: true, ...result };
    } catch (err: any) {
      reply.code(400).send({ error: err.message });
    }
  });

  app.delete("/api/admin/backup/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await backupManager.deleteBackup(id);
    if (!deleted) {
      reply.code(404).send({ error: "Backup not found" });
      return;
    }
    return { ok: true };
  });

  // ── Config Export/Import ──
  app.get("/api/admin/config/export", { preHandler: requireAuth }, async () => {
    const agentData = config?.agentConfig?.getAll() || {};
    const botData = { botName: config?.botConfigManager?.getBotName() || "YETIFORGE" };

    let telegramData: any = {};
    try {
      const envContent = await readFile(join(process.cwd(), ".env"), "utf-8");
      const userMatch = envContent.match(/ALLOWED_USER_IDS=(.+)/);
      telegramData.allowedUserIds = userMatch
        ? userMatch[1].split(",").map((s: string) => s.trim()).filter(Boolean)
        : [];
    } catch {}

    return {
      exportedAt: Date.now(),
      version: "1.0",
      agentConfig: agentData,
      botConfig: botData,
      telegramConfig: telegramData,
    };
  });

  app.post("/api/admin/config/import", { preHandler: requireAuth }, async (request, reply) => {
    const body = request.body as any;
    if (!body || typeof body !== "object") {
      reply.code(400).send({ error: "Invalid config data" });
      return;
    }

    const applied: string[] = [];

    // Apply agent config
    if (body.agentConfig && config?.agentConfig) {
      const ac = body.agentConfig;
      for (const tier of ["chat", "executor"] as const) {
        if (ac[tier]) {
          if (ac[tier].model) config.agentConfig.setModel(tier, ac[tier].model);
          if (ac[tier].timeoutMs !== undefined) config.agentConfig.setTimeoutMs(tier, ac[tier].timeoutMs);
        }
      }
      await config.agentConfig.save();
      applied.push("agentConfig");
    }

    // Apply bot config
    if (body.botConfig && config?.botConfigManager) {
      if (body.botConfig.botName) {
        config.botConfigManager.setBotName(body.botConfig.botName);
        await config.botConfigManager.save();
        applied.push("botConfig");
      }
    }

    return { ok: true, applied };
  });

  app.get("/api/logs", { preHandler: requireAuth }, async (request) => {
    const query = request.query as { lines?: string };
    const lines = Math.min(parseInt(query.lines || "50", 10) || 50, 200);
    const logs = await getRecentLogs(lines);
    return { logs };
  });

  app.get("/api/health", async () => {
    return { ok: true, timestamp: Date.now() };
  });

  // ── Webhook API routes ──
  if (config?.webhookManager) {
    const wm = config.webhookManager;

    // List webhooks (secrets masked)
    app.get("/api/webhooks", { preHandler: requireAuth }, async () => {
      return { webhooks: wm.listMasked() };
    });

    // Create webhook
    app.post("/api/webhooks", { preHandler: requireAuth }, async (request) => {
      const body = request.body as { chatId: number; name: string; task: string };
      if (!body?.chatId || !body?.name || !body?.task) {
        return { error: "Required: chatId, name, task" };
      }
      const webhook = wm.createWebhook(body.chatId, body.name, body.task);
      return { webhook };
    });

    // Delete webhook
    app.delete("/api/webhooks/:id", { preHandler: requireAuth }, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (wm.removeWebhook(id)) {
        return { ok: true };
      }
      reply.code(404);
      return { error: "Webhook not found" };
    });

    // Trigger webhook (authenticated by webhook secret, not admin auth)
    app.post("/api/webhooks/:id/trigger", async (request, reply) => {
      const { id } = request.params as { id: string };
      const secret = request.headers["x-webhook-secret"] as string;

      if (!secret) {
        reply.code(401);
        return { error: "Missing X-Webhook-Secret header" };
      }

      const webhook = wm.getWebhookById(id);
      if (!webhook || webhook.secret !== secret) {
        reply.code(403);
        return { error: "Invalid webhook ID or secret" };
      }

      if (!webhook.enabled) {
        reply.code(403);
        return { error: "Webhook is disabled" };
      }

      // Trigger in background
      const payload = request.body || {};
      wm.trigger(id, payload).catch((err) => {
        logger.error({ id, err }, "Webhook trigger background error");
      });

      return { ok: true, message: "Webhook triggered" };
    });
  }

  // ── Agent Registry routes (REST + SSE) ──
  if (config?.agentRegistry) {
    registerAgentRoutes(app, config.agentRegistry, requireAuth);
  }

  // API-only 404 handler (UI is served by Nginx)
  app.setNotFoundHandler(async (request, reply) => {
    reply.code(404);
    return { error: "Not found" };
  });

  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "Status server started");

  return app;
}
