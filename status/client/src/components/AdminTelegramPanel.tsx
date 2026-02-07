import { useState, useEffect } from "react";
import {
  getTelegramStatus,
  updateTelegramConfig,
  restartService,
} from "../lib/adminApi";

interface Props {
  token: string;
}

interface TelegramStatus {
  configured: boolean;
  botRunning: boolean;
  botToken: string;
  allowedUserIds: string[];
  allowedUserCount: number;
}

export function AdminTelegramPanel({ token }: Props) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Edit mode
  const [editing, setEditing] = useState(false);
  const [editToken, setEditToken] = useState("");
  const [editUserIds, setEditUserIds] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [restarting, setRestarting] = useState(false);

  const fetchStatus = () => {
    setLoading(true);
    getTelegramStatus(token)
      .then((s) => {
        setStatus(s);
        setEditUserIds(s.allowedUserIds.join(", "));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchStatus();
  }, [token]);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg("");
    setError("");
    try {
      const updates: { botToken?: string; allowedUserIds?: string[] } = {};

      if (editToken.trim()) {
        updates.botToken = editToken.trim();
      }

      const ids = editUserIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length > 0) {
        updates.allowedUserIds = ids;
      }

      const result = await updateTelegramConfig(updates, token);
      if (result.restartRequired) {
        setSaveMsg("Config saved. Restart required to apply changes.");
      } else {
        setSaveMsg("Config saved.");
      }
      setEditToken("");
      setEditing(false);
      fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    setSaveMsg("");
    try {
      await restartService(token);
      setSaveMsg(
        "Restart initiated. Page may disconnect briefly while the service restarts."
      );
    } catch {
      // Expected — the restart kills the server, so the fetch will fail
      setSaveMsg(
        "Restart initiated. Page may disconnect briefly while the service restarts."
      );
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-bold uppercase font-mono">Telegram Bot</h2>
        {status && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="bg-brutal-blue text-brutal-white font-bold uppercase py-0.5 px-2 brutal-border text-[10px] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none brutal-shadow transition-all"
          >
            Edit
          </button>
        )}
      </div>

      {loading && <p className="font-mono text-xs">Checking...</p>}
      {error && <p className="font-mono text-xs text-brutal-red mb-1">{error}</p>}
      {saveMsg && <p className="font-mono text-xs text-brutal-green font-bold mb-1">{saveMsg}</p>}

      {status && !editing && (
        <div className="space-y-1 font-mono text-xs">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <div className="flex items-center justify-between">
              <span className="uppercase font-bold text-[10px]">Configured</span>
              <span className={`px-1.5 py-0.5 font-bold text-[10px] ${status.configured ? "bg-brutal-green text-brutal-black" : "bg-brutal-red text-brutal-white"}`}>
                {status.configured ? "YES" : "NO"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="uppercase font-bold text-[10px]">Running</span>
              <span className={`px-1.5 py-0.5 font-bold text-[10px] ${status.botRunning ? "bg-brutal-green text-brutal-black" : "bg-brutal-red text-brutal-white"}`}>
                {status.botRunning ? "YES" : "NO"}
              </span>
            </div>
          </div>
          {status.botToken && (
            <div className="flex justify-between text-[10px]">
              <span className="uppercase font-bold">Token</span>
              <span className="text-brutal-black/60 truncate ml-2">{status.botToken}</span>
            </div>
          )}
          <div className="flex justify-between text-[10px]">
            <span className="uppercase font-bold">Allowed Users</span>
            <span className="font-bold">{status.allowedUserCount}</span>
          </div>
          {status.allowedUserIds.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {status.allowedUserIds.map((id) => (
                <span key={id} className="bg-brutal-bg px-1.5 py-0.5 brutal-border text-[10px]">{id}</span>
              ))}
            </div>
          )}

          <button
            onClick={handleRestart}
            disabled={restarting}
            className="w-full mt-1 bg-brutal-orange text-brutal-black font-bold uppercase py-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-[10px]"
          >
            {restarting ? "Restarting..." : "Restart Bot Service"}
          </button>
        </div>
      )}

      {editing && (
        <div className="space-y-2">
          <div>
            <label className="block font-mono text-[10px] uppercase font-bold mb-0.5">Bot Token</label>
            <input
              type="text"
              value={editToken}
              onChange={(e) => setEditToken(e.target.value)}
              placeholder={status?.botToken ? `Current: ${status.botToken}` : "Enter bot token"}
              className="w-full brutal-border p-1.5 font-mono text-xs bg-brutal-bg"
            />
            <p className="font-mono text-[10px] text-brutal-black/40 mt-0.5">From @BotFather. Blank = keep current.</p>
          </div>

          <div>
            <label className="block font-mono text-[10px] uppercase font-bold mb-0.5">Allowed User IDs</label>
            <input
              type="text"
              value={editUserIds}
              onChange={(e) => setEditUserIds(e.target.value)}
              placeholder="Comma-separated IDs"
              className="w-full brutal-border p-1.5 font-mono text-xs bg-brutal-bg"
            />
            <p className="font-mono text-[10px] text-brutal-black/40 mt-0.5">Use @userinfobot to find yours.</p>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 bg-brutal-green text-brutal-black font-bold uppercase py-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-xs"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={() => { setEditing(false); setEditToken(""); setError(""); }}
              className="flex-1 bg-brutal-white text-brutal-black font-bold uppercase py-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
