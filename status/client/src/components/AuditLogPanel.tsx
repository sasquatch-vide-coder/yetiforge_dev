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
    `px-1.5 py-0.5 text-[10px] font-bold uppercase font-mono brutal-border transition-all ${
      active
        ? "bg-brutal-black text-brutal-white"
        : "bg-brutal-white text-brutal-black hover:bg-brutal-bg"
    }`;

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-4 col-span-full">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-bold uppercase font-mono">Audit Log</h2>
        <button
          onClick={() => {
            fetchAuditLog();
            fetchLoginAttempts();
          }}
          className="bg-brutal-black text-brutal-white font-bold uppercase py-1.5 px-3 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs font-mono disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {/* Locked IPs */}
      {lockedIps.length > 0 && (
        <div className="bg-brutal-red/10 brutal-border p-2 mb-2">
          <h3 className="text-[10px] font-bold uppercase font-mono mb-1">
            Locked IPs
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {lockedIps.map(([ip, info]) => (
              <div
                key={ip}
                className="flex items-center gap-1.5 bg-brutal-white brutal-border px-2 py-0.5"
              >
                <span className="font-mono text-[10px] font-bold">{ip}</span>
                <span className="text-[10px] text-brutal-black/60">
                  {info.attempts} attempts
                </span>
                <button
                  onClick={() => handleUnlock(ip)}
                  disabled={unlocking === ip}
                  className="bg-brutal-orange text-brutal-white font-bold uppercase py-0.5 px-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-[10px] font-mono disabled:opacity-50"
                >
                  {unlocking === ip ? "..." : "Unlock"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action filters */}
      <div className="flex flex-wrap items-center gap-1 mb-2 overflow-x-auto">
        <span className="font-bold uppercase text-[10px] tracking-widest mr-1">
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
        <p className="text-brutal-red font-mono text-[10px] mb-1">{error}</p>
      )}
      {loading && (
        <p className="font-mono text-xs text-brutal-black/60 mb-1">
          Loading...
        </p>
      )}

      {/* Table (desktop) */}
      {!loading && (
        <>
          <div className="hidden md:block w-full overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="bg-brutal-black text-brutal-white uppercase">
                  <th className="px-1.5 py-0.5 text-left">Time</th>
                  <th className="px-1.5 py-0.5 text-left">Action</th>
                  <th className="px-1.5 py-0.5 text-left">IP</th>
                  <th className="px-1.5 py-0.5 text-left">Details</th>
                  <th className="px-1.5 py-0.5 text-left">Username</th>
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
                    <td className="px-1.5 py-0.5 whitespace-nowrap">
                      {timeAgo(entry.timestamp)}
                    </td>
                    <td className="px-1.5 py-0.5">
                      <span
                        className={`px-1.5 py-0.5 font-bold text-[10px] ${actionColor(
                          entry.action
                        )}`}
                      >
                        {entry.action.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-1.5 py-0.5 font-mono">
                      {entry.ip || "—"}
                    </td>
                    <td className="px-1.5 py-0.5 max-w-[300px] truncate">
                      {entry.details || "—"}
                    </td>
                    <td className="px-1.5 py-0.5">{entry.username || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {entries.length === 0 && (
              <div className="text-center text-[10px] text-brutal-black/40 py-2 uppercase">
                No audit log entries
              </div>
            )}
          </div>

          {/* Mobile card layout */}
          <div className="md:hidden space-y-2">
            {entries.length === 0 && (
              <div className="text-center text-[10px] text-brutal-black/40 py-2 uppercase">
                No audit log entries
              </div>
            )}
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="bg-brutal-bg brutal-border p-2 space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`px-1.5 py-0.5 font-bold text-[10px] ${actionColor(
                      entry.action
                    )}`}
                  >
                    {entry.action.replace(/_/g, " ")}
                  </span>
                  <span className="text-[10px] text-brutal-black/60">
                    {timeAgo(entry.timestamp)}
                  </span>
                </div>
                {entry.details && (
                  <p className="text-[10px] font-mono text-brutal-black/70 break-words">
                    {entry.details}
                  </p>
                )}
                <div className="flex justify-between text-[10px] text-brutal-black/50">
                  <span className="font-mono">{entry.ip || "—"}</span>
                  <span>{entry.username || "—"}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Footer info */}
      <div className="mt-2 text-[10px] text-brutal-black/40 uppercase">
        Auto-refresh every 30s &middot; Showing up to 100 entries
      </div>
    </div>
  );
}
