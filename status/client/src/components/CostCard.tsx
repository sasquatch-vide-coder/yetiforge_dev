import { useState, useEffect, useCallback } from "react";
import { useAdminAuth } from "../hooks/useAdminAuth";
import type { InvocationEntry } from "../hooks/useStatus";

interface LifetimeStats {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalInvocations: number;
  firstRecordedAt: string;
  lastUpdatedAt: string;
}

interface AggregateStats {
  totalCost: number;
  totalInvocations: number;
  errors: number;
  p50DurationMs: number;
  p95DurationMs: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

interface Props {
  invocations: InvocationEntry[];
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function extractPrimaryModel(modelUsage?: Record<string, any>): string {
  if (!modelUsage || typeof modelUsage !== "object") return "—";
  const models = Object.keys(modelUsage);
  if (models.length === 0) return "—";
  // Return the model with the most tokens
  let best = models[0];
  let bestTokens = 0;
  for (const m of models) {
    const u = modelUsage[m];
    const tokens = (u?.inputTokens || 0) + (u?.outputTokens || 0);
    if (tokens > bestTokens) {
      bestTokens = tokens;
      best = m;
    }
  }
  // Shorten model name for display
  return best.replace("claude-", "").replace("anthropic.", "");
}

type TierFilter = "all" | "chat" | "executor";
type StatusFilter = "all" | "success" | "error";

export function CostCard({ invocations }: Props) {
  const { token } = useAdminAuth();
  const [lifetimeStats, setLifetimeStats] = useState<LifetimeStats | null>(null);
  const [aggStats, setAggStats] = useState<AggregateStats | null>(null);
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const fetchLifetimeStats = useCallback(async () => {
    try {
      const headers: HeadersInit = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/lifetime-stats", { headers });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.error) {
        setLifetimeStats(data);
      }
    } catch {
      // Non-critical
    }
  }, [token]);

  const fetchAggStats = useCallback(async () => {
    try {
      const headers: HeadersInit = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/stats", { headers });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.error) {
        setAggStats(data);
      }
    } catch {
      // Non-critical
    }
  }, [token]);

  useEffect(() => {
    fetchLifetimeStats();
    fetchAggStats();
    const timer1 = setInterval(fetchLifetimeStats, 10000);
    const timer2 = setInterval(fetchAggStats, 10000);
    return () => {
      clearInterval(timer1);
      clearInterval(timer2);
    };
  }, [fetchLifetimeStats, fetchAggStats]);

  // Rolling window stats from recent invocations
  const recentCost = invocations.reduce((sum, i) => sum + (i.costUsd || 0), 0);
  const recentCount = invocations.length;
  const avgCost = recentCount > 0 ? recentCost / recentCount : 0;
  const totalTurns = invocations.reduce((sum, i) => sum + (i.numTurns || 0), 0);
  const errors = invocations.filter((i) => i.isError).length;

  // Use lifetime stats for "All Time" display, fall back to rolling window
  const allTimeCost = lifetimeStats?.totalCost ?? recentCost;
  const allTimeInvocations = lifetimeStats?.totalInvocations ?? recentCount;
  const allTimeInput = lifetimeStats?.totalInputTokens ?? 0;
  const allTimeOutput = lifetimeStats?.totalOutputTokens ?? 0;
  const allTimeCacheRead = lifetimeStats?.totalCacheReadTokens ?? 0;
  const allTimeCacheCreation = lifetimeStats?.totalCacheCreationTokens ?? 0;

  // Error rate
  const totalInv = aggStats?.totalInvocations ?? allTimeInvocations;
  const totalErrors = aggStats?.errors ?? errors;
  const errorRate = totalInv > 0 ? (totalErrors / totalInv) * 100 : 0;
  const errorRateColor = errorRate < 2 ? "text-brutal-green" : errorRate <= 5 ? "text-brutal-yellow" : "text-brutal-red";

  // Cache hit rate
  const cacheRead = allTimeCacheRead;
  const cacheCreation = allTimeCacheCreation;
  const cacheTotal = cacheRead + cacheCreation;
  const cacheHitRate = cacheTotal > 0 ? (cacheRead / cacheTotal) * 100 : 0;
  const cacheHitColor = cacheHitRate > 70 ? "text-brutal-green" : cacheHitRate >= 40 ? "text-brutal-yellow" : "text-brutal-red";

  // P50 / P95 latency
  const p50 = aggStats?.p50DurationMs ?? 0;
  const p95 = aggStats?.p95DurationMs ?? 0;

  // Filtered invocations for table
  const filteredInvocations = invocations.filter((inv) => {
    if (tierFilter !== "all" && inv.tier !== tierFilter) return false;
    if (statusFilter === "success" && inv.isError) return false;
    if (statusFilter === "error" && !inv.isError) return false;
    return true;
  });

  const filterBtnClass = (active: boolean) =>
    `px-2 py-1 text-xs font-bold uppercase font-mono brutal-border transition-all min-h-[44px] touch-manipulation ${
      active
        ? "bg-brutal-black text-brutal-white"
        : "bg-brutal-white text-brutal-black hover:bg-brutal-bg"
    }`;

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-6 col-span-full lg:col-span-2">
      <h2 className="text-sm uppercase tracking-widest mb-4 font-bold">
        Cost & Usage
      </h2>

      {/* All Time stats — top row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div className="bg-brutal-yellow brutal-border p-3">
          <div className="text-xs uppercase font-bold">All Time Cost</div>
          <div className="text-2xl font-bold">${allTimeCost.toFixed(2)}</div>
        </div>
        <div className="bg-brutal-blue/20 brutal-border p-3">
          <div className="text-xs uppercase font-bold">All Time Invocations</div>
          <div className="text-2xl font-bold">{allTimeInvocations}</div>
        </div>
        <div className="bg-brutal-purple/20 brutal-border p-3">
          <div className="text-xs uppercase font-bold">Avg Cost</div>
          <div className="text-2xl font-bold">${avgCost.toFixed(2)}</div>
        </div>
        <div className="bg-brutal-orange/20 brutal-border p-3">
          <div className="text-xs uppercase font-bold">Total Errors</div>
          <div className="text-2xl font-bold">{errors}</div>
        </div>
      </div>

      {/* Key metrics row: Error Rate, Cache Hit Rate, P50/P95 */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-brutal-bg brutal-border p-3">
          <div className="text-xs uppercase font-bold">Error Rate</div>
          <div className={`text-2xl font-bold ${errorRateColor}`}>
            {errorRate.toFixed(1)}%
          </div>
          <div className="text-xs text-brutal-black/50">{totalErrors} / {totalInv}</div>
        </div>
        <div className="bg-brutal-bg brutal-border p-3">
          <div className="text-xs uppercase font-bold">Cache Hit Rate</div>
          <div className={`text-2xl font-bold ${cacheHitColor}`}>
            {cacheHitRate.toFixed(1)}%
          </div>
          <div className="text-xs text-brutal-black/50">
            {formatTokens(cacheRead)} read / {formatTokens(cacheTotal)} total
          </div>
        </div>
        <div className="bg-brutal-bg brutal-border p-3">
          <div className="text-xs uppercase font-bold">P50 / P95 Latency</div>
          <div className="text-2xl font-bold">
            {(p50 / 1000).toFixed(0)}s{" "}
            <span className="text-brutal-black/40">/</span>{" "}
            {(p95 / 1000).toFixed(0)}s
          </div>
        </div>
      </div>

      {/* Recent Activity stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6 text-sm">
        <div className="flex justify-between">
          <span className="font-bold uppercase">Recent Cost</span>
          <span>${recentCost.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="font-bold uppercase">Total Turns</span>
          <span>{totalTurns}</span>
        </div>
        <div className="flex justify-between">
          <span className="font-bold uppercase">Recent Errors</span>
          <span className={errors > 0 ? "text-brutal-red font-bold" : ""}>{errors}</span>
        </div>
      </div>

      {/* Token usage - All Time from lifetime stats */}
      <div className="bg-brutal-bg brutal-border p-4 text-sm">
        <div className="font-bold uppercase text-xs tracking-widest mb-2">Token Usage (All Time)</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-xs uppercase text-brutal-black/60">Input</div>
            <div className="font-bold">{formatTokens(allTimeInput)}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-brutal-black/60">Output</div>
            <div className="font-bold">{formatTokens(allTimeOutput)}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-brutal-black/60">Cache Read</div>
            <div className="font-bold">{formatTokens(allTimeCacheRead)}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-brutal-black/60">Cache Write</div>
            <div className="font-bold">{formatTokens(allTimeCacheCreation)}</div>
          </div>
        </div>
      </div>

      {/* Tracking info */}
      {lifetimeStats && (
        <div className="mt-2 text-xs text-brutal-black/40 flex justify-between">
          <span>Tracking since {new Date(lifetimeStats.firstRecordedAt).toLocaleDateString()}</span>
          <span>Last used {timeAgo(new Date(lifetimeStats.lastUpdatedAt).getTime())}</span>
        </div>
      )}

      {/* Recent invocations with filters */}
      {invocations.length > 0 && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="font-bold uppercase text-xs tracking-widest mr-2">Recent</div>

            {/* Tier filters */}
            <div className="flex gap-0">
              {(["all", "chat", "executor"] as TierFilter[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTierFilter(t)}
                  className={filterBtnClass(tierFilter === t)}
                >
                  {t === "all" ? "All Tiers" : t}
                </button>
              ))}
            </div>

            {/* Status filters */}
            <div className="flex gap-0 ml-2">
              {(["all", "success", "error"] as StatusFilter[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={filterBtnClass(statusFilter === s)}
                >
                  {s === "all" ? "All Status" : s}
                </button>
              ))}
            </div>
          </div>

          {/* Desktop table */}
          <div className="hidden md:block w-full overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-brutal-black text-brutal-white uppercase">
                  <th className="px-2 py-1 text-left">Time</th>
                  <th className="px-2 py-1 text-left">Tier</th>
                  <th className="px-2 py-1 text-left">Model</th>
                  <th className="px-2 py-1 text-right">Turns</th>
                  <th className="px-2 py-1 text-right">Duration</th>
                  <th className="px-2 py-1 text-right">Cost</th>
                  <th className="px-2 py-1 text-center">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredInvocations.slice(0, 20).map((inv, i) => (
                  <tr
                    key={i}
                    className={`brutal-border border-b ${
                      i % 2 === 0 ? "bg-brutal-bg" : "bg-brutal-white"
                    }`}
                  >
                    <td className="px-2 py-1">{timeAgo(inv.timestamp)}</td>
                    <td className="px-2 py-1 uppercase text-brutal-black/60">
                      {inv.tier ? inv.tier.slice(0, 5) : "—"}
                    </td>
                    <td className="px-2 py-1 text-brutal-black/70 truncate max-w-[120px]">
                      {extractPrimaryModel(inv.modelUsage)}
                    </td>
                    <td className="px-2 py-1 text-right">{inv.numTurns || 0}</td>
                    <td className="px-2 py-1 text-right">
                      {((inv.durationMs || 0) / 1000).toFixed(1)}s
                    </td>
                    <td className="px-2 py-1 text-right font-bold">
                      ${(inv.costUsd || 0).toFixed(2)}
                    </td>
                    <td className="px-2 py-1 text-center">
                      <span
                        className={`px-1 py-0.5 font-bold ${
                          inv.isError
                            ? "bg-brutal-red text-brutal-white"
                            : "bg-brutal-green text-brutal-black"
                        }`}
                      >
                        {inv.isError ? "ERR" : "OK"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card layout */}
          <div className="md:hidden space-y-3">
            {filteredInvocations.slice(0, 20).map((inv, i) => (
              <div
                key={i}
                className="bg-brutal-bg brutal-border p-3 space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs text-brutal-black/60">
                    {timeAgo(inv.timestamp)}
                  </span>
                  <span
                    className={`px-2 py-0.5 font-bold text-xs ${
                      inv.isError
                        ? "bg-brutal-red text-brutal-white"
                        : "bg-brutal-green text-brutal-black"
                    }`}
                  >
                    {inv.isError ? "ERR" : "OK"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="uppercase text-brutal-black/60 font-bold">
                    {inv.tier ? inv.tier.slice(0, 5) : "—"}
                  </span>
                  <span className="text-brutal-black/70 truncate max-w-[150px]">
                    {extractPrimaryModel(inv.modelUsage)}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span>{inv.numTurns || 0} turns &middot; {((inv.durationMs || 0) / 1000).toFixed(1)}s</span>
                  <span className="font-bold">${(inv.costUsd || 0).toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>

          {filteredInvocations.length === 0 && (
            <div className="text-center text-xs text-brutal-black/40 py-3 uppercase">
              No invocations match filters
            </div>
          )}
        </div>
      )}
    </div>
  );
}
