import { useState, useEffect, useRef, useCallback } from "react";
import { useAdminAuth } from "./useAdminAuth";

interface ServiceStatus {
  status: string;
  uptime: string | null;
  pid: number | null;
  memory: string | null;
}

interface SystemStatus {
  serverUptime: string;
  loadAvg: number[];
  totalMemMB: number;
  freeMemMB: number;
  diskUsed: string;
  diskTotal: string;
  diskPercent: string;
}

interface Session {
  chatId: string;
  projectDir: string;
  lastUsedAt: number;
}

interface BotStatus {
  sessionCount: number;
  lastActivity: number | null;
  sessions: Session[];
}

interface ProjectsStatus {
  registered: number;
  list: Record<string, string>;
  activeProject: Record<string, string>;
}

export interface StatusData {
  timestamp: number;
  service: ServiceStatus;
  services: {
    tiffbot: ServiceStatus;
    nginx: ServiceStatus;
  };
  system: SystemStatus;
  bot: BotStatus;
  projects: ProjectsStatus;
}

export interface InvocationEntry {
  timestamp: number;
  chatId: number;
  tier?: string;
  durationMs?: number;
  durationApiMs?: number;
  costUsd?: number;
  numTurns?: number;
  stopReason?: string;
  isError: boolean;
  modelUsage?: Record<string, any>;
}

function authHeaders(token: string | null): HeadersInit {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export function useStatus() {
  const { token } = useAdminAuth();
  const [status, setStatus] = useState<StatusData | null>(null);
  const [invocations, setInvocations] = useState<InvocationEntry[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const statusTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  const invocationsTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  const logsTimer = useRef<ReturnType<typeof setInterval>>(undefined);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { headers: authHeaders(token) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(data);
      setConnected(true);
      setError(null);
      setLoading(false);
    } catch (err: any) {
      setConnected(false);
      setError(err.message);
      setLoading(false);
    }
  }, [token]);

  const fetchInvocations = useCallback(async () => {
    try {
      const res = await fetch("/api/invocations", { headers: authHeaders(token) });
      if (!res.ok) return;
      const data = await res.json();
      setInvocations(data.invocations || []);
    } catch {
      // Non-critical
    }
  }, [token]);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch("/api/logs", { headers: authHeaders(token) });
      if (!res.ok) return;
      const data = await res.json();
      setLogs(data.logs || []);
    } catch {
      // Non-critical
    }
  }, [token]);

  useEffect(() => {
    fetchStatus();
    fetchInvocations();
    fetchLogs();

    statusTimer.current = setInterval(fetchStatus, 3000);
    invocationsTimer.current = setInterval(fetchInvocations, 10000);
    logsTimer.current = setInterval(fetchLogs, 5000);

    return () => {
      clearInterval(statusTimer.current);
      clearInterval(invocationsTimer.current);
      clearInterval(logsTimer.current);
    };
  }, [fetchStatus, fetchInvocations, fetchLogs]);

  return { status, invocations, logs, loading, error, connected };
}
