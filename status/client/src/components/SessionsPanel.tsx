import { useState, useEffect, useCallback } from "react";
import {
  getAdminSessions,
  revokeAdminSession,
  revokeAllAdminSessions,
} from "../lib/adminApi";

interface Session {
  jti: string;
  stage: string;
  issuedAt: number;
  expiresAt: number;
  ip: string;
  isCurrent: boolean;
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

function timeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "expired";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function SessionsPanel({ token }: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await getAdminSessions(token);
      setSessions(data.sessions);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch sessions");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchSessions();
    const timer = setInterval(fetchSessions, 15000);
    return () => clearInterval(timer);
  }, [fetchSessions]);

  const handleRevoke = async (jti: string) => {
    setRevoking(jti);
    try {
      await revokeAdminSession(jti, token);
      await fetchSessions();
    } catch {
      // Ignore
    } finally {
      setRevoking(null);
    }
  };

  const handleRevokeAll = async () => {
    setRevokingAll(true);
    try {
      await revokeAllAdminSessions(token);
      await fetchSessions();
    } catch {
      // Ignore
    } finally {
      setRevokingAll(false);
    }
  };

  const otherSessions = sessions.filter((s) => !s.isCurrent);

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-4">
      <h2 className="text-sm font-bold uppercase mb-2 font-mono">
        Active Sessions
      </h2>

      {error && (
        <p className="text-brutal-red font-mono text-[10px] mb-1">{error}</p>
      )}
      {loading && (
        <p className="font-mono text-xs text-brutal-black/60 mb-1">
          Loading...
        </p>
      )}

      {!loading && (
        <>
          {/* Desktop table */}
          <div className="hidden md:block w-full overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="bg-brutal-black text-brutal-white uppercase">
                  <th className="px-1.5 py-0.5 text-left">Issued</th>
                  <th className="px-1.5 py-0.5 text-left">IP</th>
                  <th className="px-1.5 py-0.5 text-left">Expires In</th>
                  <th className="px-1.5 py-0.5 text-center">Status</th>
                  <th className="px-1.5 py-0.5 text-center">Action</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session, i) => (
                  <tr
                    key={session.jti}
                    className={`brutal-border border-b ${
                      i % 2 === 0 ? "bg-brutal-bg" : "bg-brutal-white"
                    }`}
                  >
                    <td className="px-1.5 py-0.5 whitespace-nowrap">
                      {timeAgo(session.issuedAt)}
                    </td>
                    <td className="px-1.5 py-0.5 font-mono">{session.ip}</td>
                    <td className="px-1.5 py-0.5 whitespace-nowrap">
                      {timeUntil(session.expiresAt)}
                    </td>
                    <td className="px-1.5 py-0.5 text-center">
                      {session.isCurrent ? (
                        <span className="bg-brutal-green text-brutal-black px-1.5 py-0.5 font-bold text-[10px]">
                          CURRENT
                        </span>
                      ) : (
                        <span className="bg-brutal-blue text-brutal-white px-1.5 py-0.5 font-bold text-[10px]">
                          ACTIVE
                        </span>
                      )}
                    </td>
                    <td className="px-1.5 py-0.5 text-center">
                      {!session.isCurrent && (
                        <button
                          onClick={() => handleRevoke(session.jti)}
                          disabled={revoking === session.jti}
                          className="bg-brutal-red text-brutal-white font-bold uppercase py-0.5 px-2 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-[10px] font-mono disabled:opacity-50"
                        >
                          {revoking === session.jti ? "..." : "Revoke"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sessions.length === 0 && (
              <div className="text-center text-[10px] text-brutal-black/40 py-2 uppercase">
                No active sessions
              </div>
            )}
          </div>

          {/* Mobile card layout */}
          <div className="md:hidden space-y-2">
            {sessions.length === 0 && (
              <div className="text-center text-[10px] text-brutal-black/40 py-2 uppercase">
                No active sessions
              </div>
            )}
            {sessions.map((session) => (
              <div
                key={session.jti}
                className="bg-brutal-bg brutal-border p-2 space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] font-bold">{session.ip}</span>
                  {session.isCurrent ? (
                    <span className="bg-brutal-green text-brutal-black px-1.5 py-0.5 font-bold text-[10px]">
                      CURRENT
                    </span>
                  ) : (
                    <span className="bg-brutal-blue text-brutal-white px-1.5 py-0.5 font-bold text-[10px]">
                      ACTIVE
                    </span>
                  )}
                </div>
                <div className="flex justify-between text-[10px] text-brutal-black/70">
                  <span>Issued {timeAgo(session.issuedAt)}</span>
                  <span>Expires in {timeUntil(session.expiresAt)}</span>
                </div>
                {!session.isCurrent && (
                  <button
                    onClick={() => handleRevoke(session.jti)}
                    disabled={revoking === session.jti}
                    className="w-full bg-brutal-red text-brutal-white font-bold uppercase py-1.5 px-3 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs font-mono disabled:opacity-50"
                  >
                    {revoking === session.jti ? "Revoking..." : "Revoke"}
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Revoke All Others */}
          {otherSessions.length > 0 && (
            <div className="mt-2">
              <button
                onClick={handleRevokeAll}
                disabled={revokingAll}
                className="bg-brutal-red text-brutal-white font-bold uppercase py-1.5 px-3 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs font-mono disabled:opacity-50"
              >
                {revokingAll
                  ? "Revoking..."
                  : `Revoke All Others (${otherSessions.length})`}
              </button>
            </div>
          )}
        </>
      )}

      {/* Footer info */}
      <div className="mt-2 text-[10px] text-brutal-black/40 uppercase">
        Auto-refresh every 15s
      </div>
    </div>
  );
}
