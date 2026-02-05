import type { InvocationEntry } from "../hooks/useStatus";

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

export function CostCard({ invocations }: Props) {
  const totalCost = invocations.reduce((sum, i) => sum + (i.costUsd || 0), 0);
  const totalInvocations = invocations.length;
  const avgCost = totalInvocations > 0 ? totalCost / totalInvocations : 0;
  const avgDuration = totalInvocations > 0
    ? invocations.reduce((sum, i) => sum + (i.durationMs || 0), 0) / totalInvocations / 1000
    : 0;
  const totalTurns = invocations.reduce((sum, i) => sum + (i.numTurns || 0), 0);
  const errors = invocations.filter((i) => i.isError).length;
  const maxTurnsHits = invocations.filter((i) => i.stopReason === "errormaxturns").length;

  // Token totals across all models
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  for (const inv of invocations) {
    if (inv.modelUsage) {
      for (const model of Object.values(inv.modelUsage)) {
        totalInput += (model.inputTokens || 0) + (model.cacheCreationInputTokens || 0);
        totalOutput += (model.outputTokens || 0);
        totalCacheRead += (model.cacheReadInputTokens || 0);
        totalCacheCreation += (model.cacheCreationInputTokens || 0);
      }
    }
  }

  const lastInvocation = invocations.length > 0 ? invocations[invocations.length - 1] : null;

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-6 col-span-full lg:col-span-2">
      <h2 className="text-sm uppercase tracking-widest mb-4 font-bold">
        Cost & Usage
      </h2>

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-brutal-yellow brutal-border p-3">
          <div className="text-xs uppercase font-bold">Total Cost</div>
          <div className="text-2xl font-bold">${totalCost.toFixed(2)}</div>
        </div>
        <div className="bg-brutal-blue/20 brutal-border p-3">
          <div className="text-xs uppercase font-bold">Invocations</div>
          <div className="text-2xl font-bold">{totalInvocations}</div>
        </div>
        <div className="bg-brutal-purple/20 brutal-border p-3">
          <div className="text-xs uppercase font-bold">Avg Cost</div>
          <div className="text-2xl font-bold">${avgCost.toFixed(2)}</div>
        </div>
        <div className="bg-brutal-orange/20 brutal-border p-3">
          <div className="text-xs uppercase font-bold">Avg Duration</div>
          <div className="text-2xl font-bold">{avgDuration.toFixed(1)}s</div>
        </div>
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 text-sm">
        <div className="flex justify-between">
          <span className="font-bold uppercase">Total Turns</span>
          <span>{totalTurns}</span>
        </div>
        <div className="flex justify-between">
          <span className="font-bold uppercase">Errors</span>
          <span className={errors > 0 ? "text-brutal-red font-bold" : ""}>{errors}</span>
        </div>
        <div className="flex justify-between">
          <span className="font-bold uppercase">Max Turns Hits</span>
          <span className={maxTurnsHits > 0 ? "text-brutal-orange font-bold" : ""}>{maxTurnsHits}</span>
        </div>
        <div className="flex justify-between">
          <span className="font-bold uppercase">Last Used</span>
          <span>{lastInvocation ? timeAgo(lastInvocation.timestamp) : "—"}</span>
        </div>
      </div>

      {/* Token usage */}
      <div className="bg-brutal-bg brutal-border p-4 text-sm">
        <div className="font-bold uppercase text-xs tracking-widest mb-2">Token Usage (All Time)</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-xs uppercase text-brutal-black/60">Input</div>
            <div className="font-bold">{formatTokens(totalInput)}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-brutal-black/60">Output</div>
            <div className="font-bold">{formatTokens(totalOutput)}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-brutal-black/60">Cache Read</div>
            <div className="font-bold">{formatTokens(totalCacheRead)}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-brutal-black/60">Cache Write</div>
            <div className="font-bold">{formatTokens(totalCacheCreation)}</div>
          </div>
        </div>
      </div>

      {/* Recent invocations */}
      {invocations.length > 0 && (
        <div className="mt-4">
          <div className="font-bold uppercase text-xs tracking-widest mb-2">Recent</div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {invocations.slice(-10).reverse().map((inv, i) => (
              <div key={i} className="flex justify-between text-xs bg-brutal-bg brutal-border px-3 py-1">
                <span>{timeAgo(inv.timestamp)}</span>
                <span>{inv.numTurns || 0} turns</span>
                <span>{((inv.durationMs || 0) / 1000).toFixed(1)}s</span>
                <span className="font-bold">${(inv.costUsd || 0).toFixed(2)}</span>
                <span className={
                  inv.isError ? "text-brutal-red" :
                  inv.stopReason === "errormaxturns" ? "text-brutal-orange" :
                  "text-brutal-green"
                }>
                  {inv.isError ? "ERR" : inv.stopReason === "errormaxturns" ? "MAX" : "OK"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
