import { useState, useEffect } from "react";
import {
  getAgentConfig,
  updateAgentConfig,
} from "../lib/adminApi";
import type { AgentConfigData, AgentTierConfig } from "../lib/adminApi";

const MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
];

interface TierEditorProps {
  label: string;
  config: AgentTierConfig;
  onChange: (updated: AgentTierConfig) => void;
}

function TierEditor({ label, config, onChange }: TierEditorProps) {
  return (
    <div>
      <h3 className="font-bold uppercase font-mono text-[10px] mb-1.5 text-brutal-black/70">{label}</h3>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="block text-[10px] uppercase font-bold font-mono mb-0.5">Model</label>
          <select
            value={config.model}
            onChange={(e) => onChange({ ...config, model: e.target.value })}
            className="w-full p-1.5 brutal-border font-mono text-xs bg-brutal-bg"
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>
        <div className="w-24 flex-shrink-0">
          <label className="block text-[10px] uppercase font-bold font-mono mb-0.5">Timeout (s)</label>
          <input
            type="number"
            min={0}
            value={config.timeoutMs > 0 ? config.timeoutMs / 1000 : 0}
            onChange={(e) => {
              const secs = Math.max(0, parseInt(e.target.value) || 0);
              onChange({ ...config, timeoutMs: secs * 1000 });
            }}
            className="w-full p-1.5 brutal-border font-mono text-xs bg-brutal-bg"
          />
        </div>
      </div>
    </div>
  );
}

export function AdminAgentPanel({ token }: { token: string }) {
  const [config, setConfig] = useState<AgentConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [statusMsg, setStatusMsg] = useState("");

  const fetchConfig = () => {
    setLoading(true);
    setError("");
    getAgentConfig(token)
      .then(setConfig)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load config"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchConfig();
  }, [token]);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setStatusMsg("");
    setError("");
    try {
      const result = await updateAgentConfig(config, token);
      setConfig(result.config);
      setStatusMsg("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save config");
    } finally {
      setSaving(false);
    }
  };

  const updateTier = (tier: keyof AgentConfigData) => (updated: AgentTierConfig) => {
    if (!config) return;
    setConfig({ ...config, [tier]: updated });
  };

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-4">
      <h2 className="text-sm font-bold uppercase mb-2 font-mono">Agent Tiers</h2>

      {loading && <p className="font-mono text-xs">Loading...</p>}
      {error && <p className="font-mono text-xs text-brutal-red mb-1">{error}</p>}
      {statusMsg && <p className="font-mono text-xs text-brutal-green font-bold mb-1">{statusMsg}</p>}

      {config && (
        <div className="space-y-3">
          <TierEditor
            label="Chat Agent"
            config={config.chat}
            onChange={updateTier("chat")}
          />
          <div className="border-t-2 border-brutal-black/20 pt-2">
            <TierEditor
              label="Executor"
              config={config.executor}
              onChange={updateTier("executor")}
            />
          </div>
          <p className="font-mono text-[10px] text-brutal-black/40">0 = no timeout</p>

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
