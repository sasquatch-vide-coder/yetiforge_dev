import { useState, useEffect, useCallback } from "react";
import { useAdminAuth } from "../hooks/useAdminAuth";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface MetricPoint {
  timestamp: string;
  cpuPercent: number;
  memUsedMB: number;
  memTotalMB: number;
  diskUsedPercent: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
}

type TimeRange = "1" | "6" | "24" | "168";

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  "1": "1h",
  "6": "6h",
  "24": "24h",
  "168": "7d",
};

function formatTimeTick(timestamp: string): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

interface TooltipPayloadEntry {
  dataKey: string;
  value: number;
  color: string;
  name: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
}

function CpuTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  const cpu = payload.find((p) => p.dataKey === "cpuPercent");
  const load = payload.find((p) => p.dataKey === "loadAvg1");
  return (
    <div
      style={{
        background: "#000",
        color: "#fff",
        border: "3px solid #fff",
        padding: "12px 16px",
        fontFamily: "monospace",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: 8, fontSize: 13 }}>
        {label ? formatTimeTick(label) : ""}
      </div>
      {cpu && (
        <div style={{ color: "#ff6b6b", fontSize: 12, marginBottom: 2 }}>
          CPU: {cpu.value.toFixed(1)}%
        </div>
      )}
      {load && (
        <div style={{ color: "#ff922b", fontSize: 12 }}>
          LOAD AVG (1m): {load.value.toFixed(2)}
        </div>
      )}
    </div>
  );
}

function MemTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  const used = payload.find((p) => p.dataKey === "memUsedMB");
  const total = payload.find((p) => p.dataKey === "memTotalMB");
  return (
    <div
      style={{
        background: "#000",
        color: "#fff",
        border: "3px solid #fff",
        padding: "12px 16px",
        fontFamily: "monospace",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: 8, fontSize: 13 }}>
        {label ? formatTimeTick(label) : ""}
      </div>
      {used && (
        <div style={{ color: "#339af0", fontSize: 12, marginBottom: 2 }}>
          USED: {used.value.toFixed(0)} MB
        </div>
      )}
      {total && (
        <div style={{ color: "#adb5bd", fontSize: 12 }}>
          TOTAL: {total.value.toFixed(0)} MB
        </div>
      )}
    </div>
  );
}

export function SystemMetricsChart() {
  const { token } = useAdminAuth();
  const [metrics, setMetrics] = useState<MetricPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<TimeRange>("24");

  const fetchMetrics = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`/api/stats/system?hours=${range}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to fetch system metrics");
      const data = await res.json();
      setMetrics(data.metrics || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, [token, range]);

  useEffect(() => {
    setLoading(true);
    fetchMetrics();
    const timer = setInterval(fetchMetrics, 60000);
    return () => clearInterval(timer);
  }, [fetchMetrics]);

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-6">
      <div className="flex items-center justify-between mb-4" style={{ borderBottom: "3px solid var(--color-brutal-black)", paddingBottom: 12 }}>
        <h2 className="text-sm uppercase tracking-widest font-bold">
          System Metrics
        </h2>
        <div className="flex gap-1">
          {(Object.keys(TIME_RANGE_LABELS) as TimeRange[]).map((key) => (
            <button
              key={key}
              onClick={() => setRange(key)}
              className={`font-bold uppercase py-1 px-3 brutal-border text-xs font-mono transition-all ${
                range === key
                  ? "bg-brutal-black text-brutal-white brutal-shadow"
                  : "bg-brutal-white text-brutal-black hover:bg-brutal-bg"
              }`}
            >
              {TIME_RANGE_LABELS[key]}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <span className="text-sm uppercase font-bold tracking-widest text-brutal-black/50">
            Loading metrics...
          </span>
        </div>
      ) : error ? (
        <div className="bg-brutal-red/10 brutal-border p-4 text-sm font-mono text-brutal-red">
          {error}
        </div>
      ) : metrics.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <span className="text-sm uppercase font-bold tracking-widest text-brutal-black/50">
            No data available
          </span>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* CPU / Load Chart */}
          <div>
            <div className="flex gap-6 mb-3 text-xs uppercase font-bold tracking-widest">
              <div className="flex items-center gap-2">
                <span style={{ display: "inline-block", width: 16, height: 4, background: "#ff6b6b" }} />
                <span>CPU %</span>
              </div>
              <div className="flex items-center gap-2">
                <span style={{ display: "inline-block", width: 16, height: 4, background: "#ff922b" }} />
                <span>Load Avg 1m</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={metrics} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={formatTimeTick}
                  tick={{ fontSize: 10, fontFamily: "monospace" }}
                  stroke="#1a1a1a"
                  strokeWidth={2}
                />
                <YAxis
                  yAxisId="cpu"
                  domain={[0, 100]}
                  tickFormatter={(v: number) => `${v}%`}
                  tick={{ fontSize: 10, fontFamily: "monospace" }}
                  stroke="#ff6b6b"
                  strokeWidth={2}
                  width={50}
                />
                <YAxis
                  yAxisId="load"
                  orientation="right"
                  tick={{ fontSize: 10, fontFamily: "monospace" }}
                  stroke="#ff922b"
                  strokeWidth={2}
                  width={40}
                />
                <Tooltip content={<CpuTooltip />} />
                <Area
                  yAxisId="cpu"
                  type="monotone"
                  dataKey="cpuPercent"
                  stroke="#ff6b6b"
                  strokeWidth={2}
                  fill="#ff6b6b"
                  fillOpacity={0.15}
                />
                <Area
                  yAxisId="load"
                  type="monotone"
                  dataKey="loadAvg1"
                  stroke="#ff922b"
                  strokeWidth={2}
                  fill="none"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Memory Chart */}
          <div>
            <div className="flex gap-6 mb-3 text-xs uppercase font-bold tracking-widest">
              <div className="flex items-center gap-2">
                <span style={{ display: "inline-block", width: 16, height: 4, background: "#339af0" }} />
                <span>Used MB</span>
              </div>
              <div className="flex items-center gap-2">
                <span style={{ display: "inline-block", width: 16, height: 4, background: "#adb5bd", borderTop: "2px dashed #adb5bd" }} />
                <span>Total MB</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={metrics} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={formatTimeTick}
                  tick={{ fontSize: 10, fontFamily: "monospace" }}
                  stroke="#1a1a1a"
                  strokeWidth={2}
                />
                <YAxis
                  tickFormatter={(v: number) => `${v}`}
                  tick={{ fontSize: 10, fontFamily: "monospace" }}
                  stroke="#339af0"
                  strokeWidth={2}
                  width={60}
                  label={{ value: "MB", angle: -90, position: "insideLeft", style: { fontSize: 10, fontFamily: "monospace" } }}
                />
                <Tooltip content={<MemTooltip />} />
                <Area
                  type="monotone"
                  dataKey="memTotalMB"
                  stroke="#adb5bd"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  fill="#adb5bd"
                  fillOpacity={0.05}
                />
                <Area
                  type="monotone"
                  dataKey="memUsedMB"
                  stroke="#339af0"
                  strokeWidth={2}
                  fill="#339af0"
                  fillOpacity={0.2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
