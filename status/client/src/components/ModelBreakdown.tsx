import { useState, useEffect, useCallback } from "react";
import { useAdminAuth } from "../hooks/useAdminAuth";

interface ModelStat {
  model: string;
  count: number;
  cost: number;
  tokens: number;
}

export function ModelBreakdown() {
  const { token } = useAdminAuth();
  const [models, setModels] = useState<ModelStat[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchModels = useCallback(async () => {
    try {
      const headers: HeadersInit = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/stats/models", { headers });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        setModels(data);
      }
    } catch {
      // Non-critical
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchModels();
    const timer = setInterval(fetchModels, 30000);
    return () => clearInterval(timer);
  }, [fetchModels]);

  const totalCost = models.reduce((sum, m) => sum + m.cost, 0);

  // Color palette for bars
  const barColors = [
    "bg-brutal-blue",
    "bg-brutal-purple",
    "bg-brutal-orange",
    "bg-brutal-green",
    "bg-brutal-yellow",
    "bg-brutal-red",
    "bg-brutal-pink",
  ];

  if (loading) {
    return (
      <div className="bg-brutal-white brutal-border brutal-shadow p-6">
        <h2 className="text-sm uppercase tracking-widest mb-4 font-bold">
          Model Breakdown
        </h2>
        <div className="text-sm uppercase font-bold text-brutal-black/40">Loading...</div>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="bg-brutal-white brutal-border brutal-shadow p-6">
        <h2 className="text-sm uppercase tracking-widest mb-4 font-bold">
          Model Breakdown
        </h2>
        <div className="text-sm text-brutal-black/40 uppercase">No model data</div>
      </div>
    );
  }

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-6">
      <h2 className="text-sm uppercase tracking-widest mb-4 font-bold">
        Model Breakdown
      </h2>

      {/* Cost proportion bar */}
      <div className="flex w-full h-6 brutal-border mb-4 overflow-hidden">
        {models.map((m, i) => {
          const pct = totalCost > 0 ? (m.cost / totalCost) * 100 : 0;
          if (pct < 0.5) return null;
          return (
            <div
              key={m.model}
              className={`${barColors[i % barColors.length]} h-full`}
              style={{ width: `${pct}%` }}
              title={`${m.model}: ${pct.toFixed(1)}%`}
            />
          );
        })}
      </div>

      {/* Model table */}
      <div className="w-full overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-brutal-black text-brutal-white uppercase">
              <th className="px-3 py-2 text-left">Model</th>
              <th className="px-3 py-2 text-right">Invocations</th>
              <th className="px-3 py-2 text-right">Cost</th>
              <th className="px-3 py-2 text-right">% of Total</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m, i) => {
              const pct = totalCost > 0 ? (m.cost / totalCost) * 100 : 0;
              return (
                <tr
                  key={m.model}
                  className={`border-b brutal-border ${
                    i % 2 === 0 ? "bg-brutal-bg" : "bg-brutal-white"
                  }`}
                >
                  <td className="px-3 py-2 font-bold">
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-3 h-3 ${barColors[i % barColors.length]} brutal-border`}
                      />
                      <span className="truncate max-w-[200px]">
                        {m.model.replace("claude-", "").replace("anthropic.", "")}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">{m.count}</td>
                  <td className="px-3 py-2 text-right font-bold">${m.cost.toFixed(4)}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-2 bg-brutal-bg brutal-border overflow-hidden">
                        <div
                          className={`h-full ${barColors[i % barColors.length]}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-12 text-right">{pct.toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Total */}
      <div className="mt-3 flex justify-between items-center bg-brutal-black text-brutal-white px-3 py-2 text-xs font-bold uppercase">
        <span>Total</span>
        <span>${totalCost.toFixed(4)}</span>
      </div>
    </div>
  );
}
