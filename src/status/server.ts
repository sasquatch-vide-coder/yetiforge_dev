import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFile, stat } from "fs/promises";
import { execSync, exec } from "child_process";
import { logger } from "../utils/logger.js";
import { AdminAuth } from "../admin/auth.js";
import { registerAdminRoutes } from "../admin/routes.js";
import { AgentConfigManager } from "../agents/agent-config.js";
import { ChatAgent } from "../agents/chat-agent.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { SessionManager } from "../claude/session-manager.js";
import { InvocationLogger } from "./invocation-logger.js";
import { WebChatStore } from "../admin/web-chat-store.js";
import { getAllInvocations, getInvocationStats } from "./database.js";

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

function getServiceStatus(): {
  status: string;
  uptime: string | null;
  pid: number | null;
  memory: string | null;
} {
  try {
    const raw = execSync("systemctl show tiffbot --no-pager", {
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

export async function startStatusServer(dataDir: string, port: number = 3069, config?: { adminJwtSecret: string; agentConfig?: AgentConfigManager; chatAgent?: ChatAgent; orchestrator?: Orchestrator; sessionManager?: SessionManager; invocationLogger?: InvocationLogger; defaultProjectDir?: string }) {
  const app = Fastify({ logger: false });

  await app.register(fastifyCors, { origin: true });

  // Admin auth
  const adminAuth = new AdminAuth(dataDir, config?.adminJwtSecret || "rumpbot-admin-default-secret");
  await adminAuth.load();

  // Web chat persistence
  const webChatStore = new WebChatStore(dataDir);
  await webChatStore.load();

  const envPath = join(process.cwd(), ".env");
  await registerAdminRoutes(app, adminAuth, envPath, config?.agentConfig, {
    chatAgent: config?.chatAgent,
    orchestrator: config?.orchestrator,
    sessionManager: config?.sessionManager,
    invocationLogger: config?.invocationLogger,
    defaultProjectDir: config?.defaultProjectDir,
    webChatStore,
  });

  // Serve built React app
  const clientDist = join(__dirname, "../../status/client/dist");
  try {
    await stat(clientDist);
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: "/",
    });
  } catch {
    logger.warn("Status client dist not found, API-only mode");
  }

  // API routes
  app.get("/api/status", async () => {
    const [service, system, sessions, projects] = await Promise.all([
      getServiceStatus(),
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
      service,
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

  app.get("/api/invocations", async () => {
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

  app.get("/api/lifetime-stats", async () => {
    try {
      const stats = getInvocationStats(dataDir);
      return stats;
    } catch (err) {
      logger.error({ err }, "Failed to get invocation stats from SQLite");
      return { error: "Failed to get stats" };
    }
  });

  app.get("/api/logs", async (request) => {
    const query = request.query as { lines?: string };
    const lines = Math.min(parseInt(query.lines || "50", 10) || 50, 200);
    const logs = await getRecentLogs(lines);
    return { logs };
  });

  app.get("/api/health", async () => {
    return { ok: true, timestamp: Date.now() };
  });

  // SPA fallback - serve index.html for non-API routes
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      reply.code(404);
      return { error: "Not found" };
    }
    try {
      const indexPath = join(clientDist, "index.html");
      const html = await readFile(indexPath, "utf-8");
      reply.type("text/html").send(html);
    } catch {
      reply.code(404);
      return { error: "Client not built" };
    }
  });

  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "Status server started");

  return app;
}
