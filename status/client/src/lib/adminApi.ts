const API_BASE = "/api/admin";

const TOKEN_KEY = "yetiforge_admin_token";

async function request<T = Record<string, unknown>>(
  path: string,
  options?: RequestInit & { token?: string }
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body) {
    headers["Content-Type"] = "application/json";
  }
  if (options?.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }
  const { token: _, ...fetchOpts } = options || {};
  const res = await fetch(`${API_BASE}${path}`, {
    ...fetchOpts,
    headers: { ...headers, ...fetchOpts?.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    const errorMessage = (err as Record<string, string>).error || "Request failed";

    // If the server returns 401 Unauthorized on an authenticated request,
    // the token is invalid/expired/revoked — clear it and redirect to login.
    // BUT: don't do this for the MFA verify endpoint — 401 there means
    // wrong code or expired partial token, not an invalid session.
    const isMfaVerify = path === "/mfa/verify";
    if (res.status === 401 && options?.token && !isMfaVerify) {
      localStorage.removeItem(TOKEN_KEY);
      // Defer redirect so the error propagates first — immediate redirect
      // aborts in-flight fetches and causes "Load failed" in Safari
      setTimeout(() => { window.location.href = "/admin"; }, 100);
    }

    throw new Error(errorMessage);
  }
  return res.json() as Promise<T>;
}

// Auth
export function getSetupStatus() {
  return request<{ isSetUp: boolean; mfaEnabled: boolean }>("/setup-status");
}

export function setup(username: string, password: string) {
  return request<{ ok: boolean; token: string }>("/setup", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function login(username: string, password: string) {
  return request<{ ok: boolean; requireMfa: boolean; token: string }>("/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function verifyMfa(code: string, token: string) {
  return request<{ ok: boolean; token: string }>("/mfa/verify", {
    method: "POST",
    body: JSON.stringify({ code }),
    token,
  });
}

// Protected endpoints
export function getClaudeStatus(token: string) {
  return request<{
    installed: boolean;
    version: string | null;
    authenticated: boolean;
    path: string | null;
    subscriptionType: string | null;
    rateLimitTier: string | null;
    credentialsExist: boolean;
    tokenExpiresAt: number | null;
    setupCommand: string;
  }>("/claude/status", { token });
}

export function checkClaudeUpdate(token: string) {
  return request<{
    currentVersion: string | null;
    updateAvailable: boolean;
    upToDate: boolean;
    output: string;
  }>("/claude/check-update", { token });
}

export function installClaudeUpdate(token: string) {
  return request<{ ok: boolean; output: string }>("/claude/update", {
    method: "POST",
    token,
  });
}

export function getTelegramStatus(token: string) {
  return request<{
    configured: boolean;
    botRunning: boolean;
    botToken: string;
    allowedUserIds: string[];
    allowedUserCount: number;
  }>("/telegram/status", { token });
}

export function updateTelegramConfig(
  config: { botToken?: string; allowedUserIds?: string[] },
  token: string
) {
  return request<{ ok: boolean; restartRequired: boolean }>(
    "/telegram/config",
    {
      method: "POST",
      body: JSON.stringify(config),
      token,
    }
  );
}

export function restartService(token: string) {
  return request<{ ok: boolean; output: string }>("/service/restart", {
    method: "POST",
    token,
  });
}

export function getSSLStatus(token: string) {
  return request<{
    hasCert: boolean;
    domain: string | null;
    expiry: string | null;
    certPath: string | null;
    autoRenew: boolean;
  }>("/ssl/status", { token });
}

export function renewSSL(token: string) {
  return request<{ ok: boolean; output: string }>("/ssl/renew", {
    method: "POST",
    token,
  });
}

export function generateSSLCert(domain: string, token: string) {
  return request<{ ok: boolean; output: string; domain?: string }>("/ssl/generate", {
    method: "POST",
    body: JSON.stringify({ domain }),
    token,
  });
}

export function getMfaSetup(token: string) {
  return request<{ secret: string; uri: string; qrCode: string }>(
    "/mfa/setup",
    { token }
  );
}

export function enableMfa(code: string, token: string) {
  return request<{ ok: boolean }>("/mfa/enable", {
    method: "POST",
    body: JSON.stringify({ code }),
    token,
  });
}

export function disableMfa(token: string) {
  return request<{ ok: boolean }>("/mfa/disable", {
    method: "POST",
    token,
  });
}

export function changePassword(
  currentPassword: string,
  newPassword: string,
  token: string
) {
  return request<{ ok: boolean }>("/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
    token,
  });
}

// Username
export function getUsername(token: string) {
  return request<{ username: string }>("/username", { token });
}

export function changeUsername(newUsername: string, token: string) {
  return request<{ ok: boolean; username: string }>("/change-username", {
    method: "POST",
    body: JSON.stringify({ newUsername }),
    token,
  });
}

// Agent Config
export interface StallThresholds {
  trivialMs: number;
  moderateMs: number;
  complexMs: number;
}

export interface AgentTierConfig {
  model: string;
  timeoutMs: number;
  stallWarning?: StallThresholds;
  stallKill?: StallThresholds;
  stallGraceMultiplier?: number;
}

export interface AgentConfigData {
  chat: AgentTierConfig;
  executor: AgentTierConfig;
}

export function getAgentConfig(token: string) {
  return request<AgentConfigData>("/agents/config", { token });
}

export function updateAgentConfig(
  config: Partial<{
    chat: Partial<AgentTierConfig>;
    executor: Partial<AgentTierConfig>;
  }>,
  token: string
) {
  return request<{ ok: boolean; config: AgentConfigData }>("/agents/config", {
    method: "POST",
    body: JSON.stringify(config),
    token,
  });
}

// Chat
export interface ChatSSEEvent {
  type: "status" | "chat_response" | "work_complete" | "error" | "done";
  data: any;
}

export function sendChatMessage(
  message: string,
  token: string,
  onEvent: (event: ChatSSEEvent) => void
): { abort: () => void } {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        onEvent({
          type: "error",
          data: { message: (err as Record<string, string>).error || "Request failed" },
        });
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        onEvent({ type: "error", data: { message: "No response stream" } });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from the buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              onEvent({ type: currentEvent as ChatSSEEvent["type"], data });
            } catch {
              // Ignore parse errors
            }
            currentEvent = "";
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        onEvent({
          type: "error",
          data: { message: err.message || "Connection failed" },
        });
      }
    }
  })();

  return {
    abort: () => controller.abort(),
  };
}

// Bot Config
export function getBotConfig(token: string) {
  return request<{ botName: string }>("/bot/config", { token });
}

export function resetChatSession(token: string) {
  return request<{ ok: boolean }>("/chat/reset", {
    method: "POST",
    token,
  });
}

export interface ChatHistoryMessage {
  id: string;
  role: "user" | "assistant" | "status" | "work_result";
  text: string;
  timestamp: number;
  phase?: string;
  workMeta?: {
    overallSuccess: boolean;
    totalCostUsd: number;
    workerCount?: number;
  };
}

export function getChatHistory(token: string) {
  return request<{ messages: ChatHistoryMessage[] }>("/chat/history", {
    method: "GET",
    token,
  });
}

// Audit Log
export function getAuditLog(token: string, opts?: { limit?: number; action?: string; from?: number; to?: number }) {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.action) params.set("action", opts.action);
  if (opts?.from) params.set("from", String(opts.from));
  if (opts?.to) params.set("to", String(opts.to));
  const qs = params.toString();
  return request<{ entries: any[]; actions?: string[] }>(`/audit-log${qs ? `?${qs}` : ""}`, { token });
}

// Security: Login Attempts
export function getLoginAttempts(token: string) {
  return request<{ attempts: Record<string, any> }>("/security/login-attempts", { token });
}

export function unlockIp(ip: string, token: string) {
  return request<{ ok: boolean }>("/security/unlock-ip", {
    method: "POST",
    body: JSON.stringify({ ip }),
    token,
  });
}

// Sessions
export function getAdminSessions(token: string) {
  return request<{ sessions: any[] }>("/sessions", { token });
}

export function revokeAdminSession(jti: string, token: string) {
  return request<{ ok: boolean; revoked: boolean }>("/sessions/revoke", {
    method: "POST",
    body: JSON.stringify({ jti }),
    token,
  });
}

export function revokeAllAdminSessions(token: string) {
  return request<{ ok: boolean; revokedCount: number }>("/sessions/revoke-all", {
    method: "POST",
    token,
  });
}

// IP Whitelist
export function getIpWhitelist(token: string) {
  return request<{ whitelist: string[] | null }>("/security/ip-whitelist", { token });
}

export function setIpWhitelist(ips: string[] | null, token: string) {
  return request<{ ok: boolean; whitelist: string[] | null }>("/security/ip-whitelist", {
    method: "POST",
    body: JSON.stringify({ ips }),
    token,
  });
}

// Chat Export
export async function exportChatHistory(format: "json" | "text", token: string): Promise<void> {
  const res = await fetch(`${API_BASE}/chat/export?format=${format}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Export failed");
  const blob = await res.blob();
  const ext = format === "json" ? "json" : "txt";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `chat-export-${Date.now()}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

// Alerts
export function getAlerts(token: string, includeAll: boolean = false) {
  return request<{ alerts: any[] }>(`/alerts${includeAll ? "?all=true" : ""}`, { token });
}

export function acknowledgeAlert(id: string, token: string) {
  return request<{ ok: boolean }>(`/alerts/${id}/acknowledge`, { method: "POST", token });
}

export function getAlertCount(token: string) {
  return request<{ count: number }>("/alerts/count", { token });
}

// Backups
export function createBackup(token: string) {
  return request<{ ok: boolean; backup: any }>("/backup/create", { method: "POST", token });
}

export function listBackups(token: string) {
  return request<{ backups: any[] }>("/backup/list", { token });
}

export function restoreBackup(id: string, token: string) {
  return request<{ ok: boolean; restoredFiles: string[] }>("/backup/restore", {
    method: "POST",
    body: JSON.stringify({ id }),
    token,
  });
}

export function deleteBackup(id: string, token: string) {
  return request<{ ok: boolean }>(`/backup/${id}`, { method: "DELETE", token });
}

// Config History
export function getConfigHistory(type: string, token: string) {
  return request<{ history: any[] }>(`/config/history?type=${type}`, { token });
}

export function rollbackConfig(type: string, snapshotId: string, token: string) {
  return request<{ ok: boolean }>("/config/rollback", {
    method: "POST",
    body: JSON.stringify({ type, snapshotId }),
    token,
  });
}

// Config Export/Import
export function exportConfig(token: string) {
  return request<any>("/config/export", { token });
}

export function importConfig(data: any, token: string) {
  return request<{ ok: boolean; applied: string[] }>("/config/import", {
    method: "POST",
    body: JSON.stringify(data),
    token,
  });
}
