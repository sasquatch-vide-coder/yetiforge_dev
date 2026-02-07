import { useState, useEffect, useCallback } from "react";
import { useAdminAuth } from "../hooks/useAdminAuth";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface TierStats {
  count: number;
  totalCost: number;
  avgCost: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  errorCount: number;
  errorRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

type TierData = Record<string, TierStats>;

const TIER_COLORS: Record<string, string> = {
  chat: "#339af0",
  orchestrator: "#9775fa",
  worker: "#ff922b",
};

const TIER_ORDER = ["chat", "orchestrator", "worker"];

function formatDuration(ms: number): string {
  return (ms / 1000).toFixed(2) + "s";
}

function formatCost(cost: number): string {
  return "$" + cost.toFixed(4);
}

function errorRateColor(rate: number): string {
  if (rate < 2) return "bg-brutal-green text-brutal-black";
  if (rate < 5) return "bg-brutal-yellow text-brutal-black";
  return "bg-brutal-red text-brutal-white";
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

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;
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
      <div style={{ fontWeight: "bold", marginBottom: 8, fontSize: 13, textTransform: "uppercase" }}>
        {label}
      </div>
      {payload.map((entry) => (
        <div key={entry.dataKey} style={{ color: entry.color, fontSize: 12, marginBottom: 2 }}>
          {entry.name}: {entry.dataKey === "totalCost" ? formatCost(entry.value) : entry.value}
        </div>
      ))}
    </div>
  );
}

export function AgentMetricsPanel() {
  const { token } = useAdminAuth();
  const [tierData, setTierData] = useState<TierData>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/stats/tiers", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to fetch tier stats");
      const data = await res.json();
      setTierData(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 30000);
    return () => clearInterval(timer);
  }, [fetchData]);

  const chartData = TIER_ORDER.map((tier) => ({
    tier,
    count: tierData[tier]?.count ?? 0,
    totalCost: tierData[tier]?.totalCost ?? 0,
  }));

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-6">
      <h2
        className="text-sm uppercase tracking-widest mb-4 font-bold"
        style={{ borderBottom: "3px solid var(--color-brutal-black)", paddingBottom: 12 }}
      >
        Agent Metrics // Per Tier
      </h2>

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
      ) : (
        <>
          {/* Tier Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            {TIER_ORDER.map((tier) => {
              const stats = tierData[tier];
              if (!stats) return null;
              return (
                <div
                  key={tier}
                  className="brutal-border p-4"
                  style={{ borderLeft: `6px solid ${TIER_COLORS[tier]}` }}
                >
                  <h3 className="text-sm font-bold uppercase font-mono mb-3" style={{ color: TIER_COLORS[tier] }}>
                    {tier}
                  </h3>
                  <div className="space-y-2 text-xs font-mono">
                    <div className="flex justify-between">
                      <span className="text-brutal-black/60 uppercase">Invocations</span>
                      <span className="font-bold">{stats.count.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-brutal-black/60 uppercase">Avg Cost</span>
                      <span className="font-bold">{formatCost(stats.avgCost)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-brutal-black/60 uppercase">P50 Latency</span>
                      <span className="font-bold">{formatDuration(stats.p50DurationMs)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-brutal-black/60 uppercase">P95 Latency</span>
                      <span className="font-bold">{formatDuration(stats.p95DurationMs)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-brutal-black/60 uppercase">Error Rate</span>
                      <span className={`px-2 py-0.5 font-bold text-xs uppercase font-mono ${errorRateColor(stats.errorRate)}`}>
                        {stats.errorRate.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Bar Chart: Cost & Invocations */}
          <div className="mt-4">
            <div className="flex gap-6 mb-4 text-xs uppercase font-bold tracking-widest">
              <div className="flex items-center gap-2">
                <span style={{ display: "inline-block", width: 16, height: 10, background: "#ff6b6b" }} />
                <span>Total Cost</span>
              </div>
              <div className="flex items-center gap-2">
                <span style={{ display: "inline-block", width: 16, height: 10, background: "#339af0" }} />
                <span>Invocations</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                <XAxis
                  dataKey="tier"
                  tick={{ fontSize: 11, fontFamily: "monospace", textTransform: "uppercase" } as any}
                  stroke="#1a1a1a"
                  strokeWidth={2}
                />
                <YAxis
                  yAxisId="cost"
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                  tick={{ fontSize: 11, fontFamily: "monospace" }}
                  stroke="#ff6b6b"
                  strokeWidth={2}
                  width={70}
                />
                <YAxis
                  yAxisId="count"
                  orientation="right"
                  tick={{ fontSize: 11, fontFamily: "monospace" }}
                  stroke="#339af0"
                  strokeWidth={2}
                  width={60}
                />
                <Tooltip content={<CustomTooltip />} />
                <Bar yAxisId="cost" dataKey="totalCost" name="Cost" fill="#ff6b6b" stroke="#1a1a1a" strokeWidth={2} />
                <Bar yAxisId="count" dataKey="count" name="Invocations" fill="#339af0" stroke="#1a1a1a" strokeWidth={2} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
