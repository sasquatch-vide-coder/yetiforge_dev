import { useState, useEffect, useCallback } from "react";
import { useAdminAuth } from "../hooks/useAdminAuth";

interface Alert {
  id: string;
  type: string;
  severity: "critical" | "warning" | "info";
  message: string;
  timestamp: string;
  acknowledged: boolean;
  details?: any;
}

function severityClasses(severity: string): string {
  switch (severity) {
    case "critical":
      return "bg-brutal-red text-brutal-white";
    case "warning":
      return "bg-brutal-yellow text-brutal-black";
    default:
      return "bg-brutal-blue text-brutal-white";
  }
}

export function AlertsBanner() {
  const { token } = useAdminAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);

  const fetchAlerts = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/admin/alerts", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setAlerts((data.alerts || []).filter((a: Alert) => !a.acknowledged));
    } catch {
      // Non-critical
    }
  }, [token]);

  useEffect(() => {
    fetchAlerts();
    const timer = setInterval(fetchAlerts, 60000);
    return () => clearInterval(timer);
  }, [fetchAlerts]);

  const handleDismiss = async (id: string) => {
    if (!token) return;
    try {
      await fetch(`/api/admin/alerts/${id}/acknowledge`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // Non-critical
    }
  };

  if (alerts.length === 0) return null;

  // Show the most critical alert (critical > warning > info)
  const sorted = [...alerts].sort((a, b) => {
    const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
  });
  const topAlert = sorted[0];

  return (
    <div
      className={`brutal-border brutal-shadow mb-4 px-4 py-3 flex items-center justify-between gap-4 ${severityClasses(topAlert.severity)}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="px-2 py-0.5 font-bold text-xs uppercase font-mono bg-brutal-black/20 shrink-0">
          {topAlert.severity}
        </span>
        <span className="font-mono text-sm font-bold truncate">
          {topAlert.message}
        </span>
        {alerts.length > 1 && (
          <span className="px-2 py-0.5 font-bold text-xs uppercase font-mono bg-brutal-black/20 shrink-0">
            +{alerts.length - 1} more
          </span>
        )}
      </div>
      <button
        onClick={() => handleDismiss(topAlert.id)}
        className="bg-brutal-black text-brutal-white font-bold uppercase py-1 px-3 brutal-border text-xs font-mono hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none brutal-shadow transition-all shrink-0"
      >
        Dismiss
      </button>
    </div>
  );
}
