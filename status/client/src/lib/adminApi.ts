const API_BASE = "/api/admin";

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
    throw new Error((err as Record<string, string>).error || "Request failed");
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
