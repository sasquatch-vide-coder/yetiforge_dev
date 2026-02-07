import { useState, useEffect, useCallback } from "react";

interface Alert {
  id: string;
  type: string;
  severity: "critical" | "warning" | "info";
  message: string;
  timestamp: string;
  acknowledged: boolean;
  details?: any;
}

interface Props {
  token: string;
}

const TYPE_COLORS: Record<string, string> = {
  ssl_expiry: "bg-brutal-purple text-brutal-white",
  bot_crash: "bg-brutal-red text-brutal-white",
  high_error_rate: "bg-brutal-orange text-brutal-white",
  disk_space: "bg-brutal-yellow text-brutal-black",
  memory_high: "bg-brutal-blue text-brutal-white",
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-brutal-red text-brutal-white",
  warning: "bg-brutal-yellow text-brutal-black",
  info: "bg-brutal-blue text-brutal-white",
};

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AlertsPanel({ token }: Props) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/alerts?all=true", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((err as Record<string, string>).error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setAlerts(data.alerts || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch alerts");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  const handleAcknowledge = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/alerts/${id}/acknowledge`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((err as Record<string, string>).error || `HTTP ${res.status}`);
      }
      setAlerts((prev) =>
        prev.map((a) => (a.id === id ? { ...a, acknowledged: true } : a))
      );
    } catch {
      // Non-critical
    }
  };

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-4">
      <h2 className="text-sm font-bold uppercase mb-2 font-mono">Alerts</h2>

      {error && (
        <p className="font-mono text-[10px] text-brutal-red mb-1">{error}</p>
      )}

      {loading ? (
        <p className="text-xs font-mono text-brutal-black/50 uppercase">Loading alerts...</p>
      ) : alerts.length === 0 ? (
        <p className="text-xs font-mono text-brutal-black/50 uppercase py-2 text-center">
          No alerts
        </p>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-[10px] font-mono">
              <thead>
                <tr className="bg-brutal-black text-brutal-white uppercase">
                  <th className="text-left px-1.5 py-0.5">Time</th>
                  <th className="text-left px-1.5 py-0.5">Type</th>
                  <th className="text-left px-1.5 py-0.5">Severity</th>
                  <th className="text-left px-1.5 py-0.5">Message</th>
                  <th className="text-left px-1.5 py-0.5">Status</th>
                  <th className="text-left px-1.5 py-0.5">Action</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert, i) => (
                  <tr
                    key={alert.id}
                    className={`${i % 2 === 0 ? "bg-brutal-bg" : "bg-brutal-white"} ${
                      alert.acknowledged ? "opacity-50" : ""
                    }`}
                  >
                    <td className="px-1.5 py-0.5 whitespace-nowrap">{formatTime(alert.timestamp)}</td>
                    <td className="px-1.5 py-0.5">
                      <span
                        className={`px-1.5 py-0.5 font-bold text-[10px] uppercase font-mono ${
                          TYPE_COLORS[alert.type] || "bg-brutal-black text-brutal-white"
                        }`}
                      >
                        {alert.type.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-1.5 py-0.5">
                      <span
                        className={`px-1.5 py-0.5 font-bold text-[10px] uppercase font-mono ${
                          SEVERITY_COLORS[alert.severity] || "bg-brutal-black text-brutal-white"
                        }`}
                      >
                        {alert.severity}
                      </span>
                    </td>
                    <td className="px-1.5 py-0.5">{alert.message}</td>
                    <td className="px-1.5 py-0.5">
                      <span
                        className={`px-1.5 py-0.5 font-bold text-[10px] uppercase font-mono ${
                          alert.acknowledged
                            ? "bg-brutal-bg text-brutal-black/50"
                            : "bg-brutal-green text-brutal-black"
                        }`}
                      >
                        {alert.acknowledged ? "Ack'd" : "Active"}
                      </span>
                    </td>
                    <td className="px-1.5 py-0.5">
                      {!alert.acknowledged && (
                        <button
                          onClick={() => handleAcknowledge(alert.id)}
                          className="bg-brutal-black text-brutal-white font-bold uppercase py-0.5 px-2 brutal-border text-[10px] font-mono hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none brutal-shadow transition-all"
                        >
                          Ack
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card layout */}
          <div className="md:hidden space-y-2">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className={`bg-brutal-bg brutal-border p-2 space-y-1 ${
                  alert.acknowledged ? "opacity-50" : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`px-1.5 py-0.5 font-bold text-[10px] uppercase font-mono ${
                      TYPE_COLORS[alert.type] || "bg-brutal-black text-brutal-white"
                    }`}
                  >
                    {alert.type.replace(/_/g, " ")}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 font-bold text-[10px] uppercase font-mono ${
                      SEVERITY_COLORS[alert.severity] || "bg-brutal-black text-brutal-white"
                    }`}
                  >
                    {alert.severity}
                  </span>
                </div>
                <p className="text-[10px] font-mono">{alert.message}</p>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-brutal-black/60">
                    {formatTime(alert.timestamp)}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 font-bold text-[10px] uppercase font-mono ${
                      alert.acknowledged
                        ? "bg-brutal-bg text-brutal-black/50"
                        : "bg-brutal-green text-brutal-black"
                    }`}
                  >
                    {alert.acknowledged ? "Ack'd" : "Active"}
                  </span>
                </div>
                {!alert.acknowledged && (
                  <button
                    onClick={() => handleAcknowledge(alert.id)}
                    className="w-full bg-brutal-black text-brutal-white font-bold uppercase py-1.5 px-3 brutal-border text-xs font-mono hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none brutal-shadow transition-all"
                  >
                    Acknowledge
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
