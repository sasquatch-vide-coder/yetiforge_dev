import { useState, useEffect, useRef, useCallback } from "react";

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
  system: SystemStatus;
  bot: BotStatus;
  projects: ProjectsStatus;
}

export interface InvocationEntry {
  timestamp: number;
  chatId: number;
  durationMs?: number;
  durationApiMs?: number;
  costUsd?: number;
  numTurns?: number;
  stopReason?: string;
  isError: boolean;
  modelUsage?: Record<string, any>;
}

export function useStatus() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [invocations, setInvocations] = useState<InvocationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const statusTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  const invocationsTimer = useRef<ReturnType<typeof setInterval>>(undefined);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
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
  }, []);

  const fetchInvocations = useCallback(async () => {
    try {
      const res = await fetch("/api/invocations");
      if (!res.ok) return;
      const data = await res.json();
      setInvocations(data.invocations || []);
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchInvocations();

    statusTimer.current = setInterval(fetchStatus, 3000);
    invocationsTimer.current = setInterval(fetchInvocations, 10000);

    return () => {
      clearInterval(statusTimer.current);
      clearInterval(invocationsTimer.current);
    };
  }, [fetchStatus, fetchInvocations]);

  return { status, invocations, loading, error, connected };
}
