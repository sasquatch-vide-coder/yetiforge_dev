import { useState, useEffect, useCallback } from "react";
import {
  getAuditLog,
  getLoginAttempts,
  unlockIp,
} from "../lib/adminApi";

interface AuditEntry {
  id: number;
  timestamp: number;
  action: string;
  ip: string | null;
  details: string | null;
  username: string | null;
}

interface LoginAttempt {
  attempts: number;
  firstAttemptAt: number;
  lockedUntil: number | null;
  currentlyLocked: boolean;
}

interface Props {
  token: string;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function actionColor(action: string): string {
  if (action === "login_success") return "bg-brutal-green text-brutal-black";
  if (action === "login_failure" || action === "login_blocked")
    return "bg-brutal-red text-brutal-white";
  if (action.startsWith("mfa_")) return "bg-brutal-purple text-brutal-white";
  if (action === "password_change") return "bg-brutal-orange text-brutal-white";
  if (
    action.startsWith("config_") ||
    action.startsWith("agent_config") ||
    action.startsWith("telegram_") ||
    action.startsWith("bot_")
  )
    return "bg-brutal-blue text-brutal-white";
  if (action === "service_restart")
    return "bg-brutal-yellow text-brutal-black";
  if (action.startsWith("ssl")) return "bg-brutal-blue text-brutal-white";
  if (action === "chat_reset") return "bg-brutal-black/40 text-brutal-white";
  return "bg-brutal-bg text-brutal-black";
}

export function AuditLogPanel({ token }: Props) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [loginAttempts, setLoginAttempts] = useState<
    Record<string, LoginAttempt>
  >({});
  const [unlocking, setUnlocking] = useState<string | null>(null);

  const fetchAuditLog = useCallback(async () => {
    try {
      const opts: { limit?: number; action?: string } = { limit: 100 };
      if (actionFilter !== "all") opts.action = actionFilter;
      const data = await getAuditLog(token, opts);
      setEntries(data.entries);
      if (data.actions) setActions(data.actions);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch audit log");
    } finally {
      setLoading(false);
    }
  }, [token, actionFilter]);

  const fetchLoginAttempts = useCallback(async () => {
    try {
      const data = await getLoginAttempts(token);
      setLoginAttempts(data.attempts);
    } catch {
      // Non-critical
    }
  }, [token]);

  useEffect(() => {
    fetchAuditLog();
    fetchLoginAttempts();
    const timer = setInterval(() => {
      fetchAuditLog();
      fetchLoginAttempts();
    }, 30000);
    return () => clearInterval(timer);
  }, [fetchAuditLog, fetchLoginAttempts]);

  const handleUnlock = async (ip: string) => {
    setUnlocking(ip);
    try {
      await unlockIp(ip, token);
      await fetchLoginAttempts();
    } catch {
      // Ignore
    } finally {
      setUnlocking(null);
    }
  };

  const lockedIps = Object.entries(loginAttempts).filter(
    ([, v]) => v.currentlyLocked
  );

  const filterBtnClass = (active: boolean) =>
    `px-2 py-1 text-xs font-bold uppercase font-mono brutal-border transition-all ${
      active
        ? "bg-brutal-black text-brutal-white"
        : "bg-brutal-white text-brutal-black hover:bg-brutal-bg"
    }`;

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-6 col-span-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold uppercase font-mono">Audit Log</h2>
        <button
          onClick={() => {
            fetchAuditLog();
            fetchLoginAttempts();
          }}
          className="bg-brutal-black text-brutal-white font-bold uppercase py-2 px-4 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-sm font-mono disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {/* Locked IPs */}
      {lockedIps.length > 0 && (
        <div className="bg-brutal-red/10 brutal-border p-4 mb-4">
          <h3 className="text-sm font-bold uppercase font-mono mb-2">
            Locked IPs
          </h3>
          <div className="flex flex-wrap gap-2">
            {lockedIps.map(([ip, info]) => (
              <div
                key={ip}
                className="flex items-center gap-2 bg-brutal-white brutal-border px-3 py-1"
              >
                <span className="font-mono text-sm font-bold">{ip}</span>
                <span className="text-xs text-brutal-black/60">
                  {info.attempts} attempts
                </span>
                <button
                  onClick={() => handleUnlock(ip)}
                  disabled={unlocking === ip}
                  className="bg-brutal-orange text-brutal-white font-bold uppercase py-1 px-2 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs font-mono disabled:opacity-50"
                >
                  {unlocking === ip ? "..." : "Unlock"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="font-bold uppercase text-xs tracking-widest mr-2">
          Filter
        </span>
        <div className="flex flex-wrap gap-0">
          <button
            onClick={() => setActionFilter("all")}
            className={filterBtnClass(actionFilter === "all")}
          >
            All
          </button>
          {actions.map((a) => (
            <button
              key={a}
              onClick={() => setActionFilter(a)}
              className={filterBtnClass(actionFilter === a)}
            >
              {a.replace(/_/g, " ")}
            </button>
          ))}
        </div>
      </div>

      {/* Error / Loading */}
      {error && (
        <p className="text-brutal-red font-mono text-sm mb-2">{error}</p>
      )}
      {loading && (
        <p className="font-mono text-sm text-brutal-black/60 mb-2">
          Loading...
        </p>
      )}

      {/* Table */}
      {!loading && (
        <div className="w-full overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-brutal-black text-brutal-white uppercase">
                <th className="px-2 py-1 text-left">Time</th>
                <th className="px-2 py-1 text-left">Action</th>
                <th className="px-2 py-1 text-left">IP</th>
                <th className="px-2 py-1 text-left">Details</th>
                <th className="px-2 py-1 text-left">Username</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr
                  key={entry.id}
                  className={`brutal-border border-b ${
                    i % 2 === 0 ? "bg-brutal-bg" : "bg-brutal-white"
                  }`}
                >
                  <td className="px-2 py-1 whitespace-nowrap">
                    {timeAgo(entry.timestamp)}
                  </td>
                  <td className="px-2 py-1">
                    <span
                      className={`px-2 py-0.5 font-bold ${actionColor(
                        entry.action
                      )}`}
                    >
                      {entry.action.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-2 py-1 font-mono">
                    {entry.ip || "—"}
                  </td>
                  <td className="px-2 py-1 max-w-[300px] truncate">
                    {entry.details || "—"}
                  </td>
                  <td className="px-2 py-1">{entry.username || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length === 0 && (
            <div className="text-center text-xs text-brutal-black/40 py-4 uppercase">
              No audit log entries
            </div>
          )}
        </div>
      )}

      {/* Footer info */}
      <div className="mt-3 text-xs text-brutal-black/40 uppercase">
        Auto-refresh every 30s &middot; Showing up to 100 entries
      </div>
    </div>
  );
}
