import { useState, useEffect } from "react";
import {
  getAgentConfig,
  updateAgentConfig,
} from "../lib/adminApi";
import type { AgentConfigData, AgentTierConfig, StallThresholds } from "../lib/adminApi";

const COMPLEXITY_TIERS = [
  { key: "trivialMs" as const, label: "Trivial" },
  { key: "moderateMs" as const, label: "Moderate" },
  { key: "complexMs" as const, label: "Complex" },
];

function msToMinutes(ms: number): string {
  return (ms / 60000).toFixed(1);
}

function minutesToMs(min: string): number {
  const val = parseFloat(min);
  return isNaN(val) ? 0 : Math.max(0, Math.round(val * 60000));
}

export function AdminStallDetectionPanel({ token }: { token: string }) {
  const [config, setConfig] = useState<AgentConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [statusMsg, setStatusMsg] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    getAgentConfig(token)
      .then(setConfig)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load config"))
      .finally(() => setLoading(false));
  }, [token]);

  const executorConfig = config?.executor;
  const warning = executorConfig?.stallWarning ?? { trivialMs: 120000, moderateMs: 240000, complexMs: 300000 };
  const kill = executorConfig?.stallKill ?? { trivialMs: 300000, moderateMs: 600000, complexMs: 900000 };
  const grace = executorConfig?.stallGraceMultiplier ?? 1.5;

  const updateExecutor = (updated: Partial<AgentTierConfig>) => {
    if (!config || !executorConfig) return;
    setConfig({ ...config, executor: { ...executorConfig, ...updated } });
  };

  const updateWarning = (key: keyof StallThresholds, val: string) => {
    updateExecutor({ stallWarning: { ...warning, [key]: minutesToMs(val) } });
  };

  const updateKill = (key: keyof StallThresholds, val: string) => {
    updateExecutor({ stallKill: { ...kill, [key]: minutesToMs(val) } });
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setStatusMsg("");
    setError("");
    try {
      const result = await updateAgentConfig(config, token);
      setConfig(result.config);
      setStatusMsg("Thresholds saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-4">
      <h2 className="text-sm font-bold uppercase mb-2 font-mono">Stall Detection</h2>

      {loading && <p className="font-mono text-xs">Loading...</p>}
      {error && <p className="font-mono text-xs text-brutal-red mb-1">{error}</p>}
      {statusMsg && <p className="font-mono text-xs text-brutal-green font-bold mb-1">{statusMsg}</p>}

      {config && executorConfig && (
        <div className="space-y-2">
          <p className="font-mono text-[10px] text-brutal-black/50 leading-tight">
            Executor thresholds (minutes). Warning = alert. Kill = abort + grace period.
          </p>

          {/* Warning & Kill side by side */}
          <div className="grid grid-cols-2 gap-3">
            {/* Warning */}
            <div>
              <label className="block text-[10px] uppercase font-bold font-mono mb-1">Warning</label>
              <div className="space-y-1">
                {COMPLEXITY_TIERS.map((tier) => (
                  <div key={`warn-${tier.key}`} className="flex items-center gap-1">
                    <label className="text-[10px] font-mono text-brutal-black/60 w-12 flex-shrink-0">
                      {tier.label}
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={msToMinutes(warning[tier.key])}
                      onChange={(e) => updateWarning(tier.key, e.target.value)}
                      className="w-full p-1 brutal-border font-mono text-xs bg-brutal-bg"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Kill */}
            <div>
              <label className="block text-[10px] uppercase font-bold font-mono mb-1">Kill</label>
              <div className="space-y-1">
                {COMPLEXITY_TIERS.map((tier) => (
                  <div key={`kill-${tier.key}`} className="flex items-center gap-1">
                    <label className="text-[10px] font-mono text-brutal-black/60 w-12 flex-shrink-0">
                      {tier.label}
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={msToMinutes(kill[tier.key])}
                      onChange={(e) => updateKill(tier.key, e.target.value)}
                      className="w-full p-1 brutal-border font-mono text-xs bg-brutal-bg"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Grace multiplier */}
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase font-bold font-mono flex-shrink-0">Grace ×</label>
            <input
              type="number"
              min={1}
              max={5}
              step={0.1}
              value={grace}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val >= 1) {
                  updateExecutor({ stallGraceMultiplier: val });
                }
              }}
              className="w-20 p-1 brutal-border font-mono text-xs bg-brutal-bg"
            />
            <span className="font-mono text-[10px] text-brutal-black/40">after kill threshold</span>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-brutal-black text-brutal-white font-bold uppercase py-1.5 px-3 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs font-mono disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
