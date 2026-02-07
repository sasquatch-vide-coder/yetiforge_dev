import { useState, useEffect } from "react";
import {
  getClaudeStatus,
  checkClaudeUpdate,
  installClaudeUpdate,
} from "../lib/adminApi";

interface Props {
  token: string;
}

interface ClaudeStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  path: string | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  credentialsExist: boolean;
  tokenExpiresAt: number | null;
  setupCommand: string;
}

function decodeRateLimitTier(tier: string): string {
  const cleaned = tier.replace(/_/g, " ").trim();
  const tierMatch = tier.match(/tier[_ ]?(\d+)/i);
  if (tierMatch) return `Tier ${tierMatch[1]}`;
  const limitMatch = tier.match(/(\d+)\s*(?:per|\/)\s*(minute|min|hour|hr|day|second|sec)/i);
  if (limitMatch) {
    const units: Record<string, string> = {
      minute: "min", min: "min", hour: "hr", hr: "hr",
      day: "day", second: "sec", sec: "sec",
    };
    return `${limitMatch[1]} req/${units[limitMatch[2].toLowerCase()] || limitMatch[2]}`;
  }
  if (cleaned.length <= 30) return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
  return cleaned;
}

function formatExpiry(expiresAt: number): string {
  const now = Date.now();
  const diff = expiresAt - now;
  if (diff <= 0) return "EXPIRED";
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((diff % 3600000) / 60000);
  return `${hours}h ${mins}m`;
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`px-1.5 py-0.5 font-bold text-[10px] ${
        ok ? "bg-brutal-green text-brutal-black" : "bg-brutal-red text-brutal-white"
      }`}
    >
      {label}
    </span>
  );
}

export function AdminClaudePanel({ token }: Props) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showSetup, setShowSetup] = useState(false);

  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    updateAvailable: boolean;
    upToDate: boolean;
    output: string;
  } | null>(null);
  const [updateOutput, setUpdateOutput] = useState("");

  const fetchStatus = () => {
    setLoading(true);
    getClaudeStatus(token)
      .then(setStatus)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchStatus();
  }, [token]);

  const handleCheckUpdate = async () => {
    setChecking(true);
    setUpdateInfo(null);
    setUpdateOutput("");
    try {
      const result = await checkClaudeUpdate(token);
      setUpdateInfo(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to check for updates");
    } finally {
      setChecking(false);
    }
  };

  const handleInstallUpdate = async () => {
    setUpdating(true);
    setUpdateOutput("");
    try {
      const result = await installClaudeUpdate(token);
      setUpdateOutput(result.output);
      setUpdateInfo(null);
      fetchStatus();
    } catch (e) {
      setUpdateOutput(e instanceof Error ? e.message : "Failed to install update");
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-4">
      <h2 className="text-sm font-bold uppercase mb-2 font-mono">Claude Code</h2>

      {loading && <p className="font-mono text-xs">Checking...</p>}
      {error && <p className="font-mono text-xs text-brutal-red mb-1">{error}</p>}

      {status && (
        <div className="space-y-2 font-mono text-xs">
          {/* Compact status grid: 2 columns of key-value pairs */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <div className="flex items-center justify-between">
              <span className="uppercase font-bold text-[10px]">Installed</span>
              <StatusBadge ok={status.installed} label={status.installed ? "YES" : "NO"} />
            </div>
            <div className="flex items-center justify-between">
              <span className="uppercase font-bold text-[10px]">Auth</span>
              <StatusBadge ok={status.authenticated} label={status.authenticated ? "YES" : "NO"} />
            </div>

            {status.version && (
              <div className="flex items-center justify-between">
                <span className="uppercase font-bold text-[10px]">Version</span>
                <span className="text-[10px]">{status.version}</span>
              </div>
            )}

            {status.tokenExpiresAt && (
              <div className="flex items-center justify-between">
                <span className="uppercase font-bold text-[10px]">Expires</span>
                <StatusBadge
                  ok={status.tokenExpiresAt > Date.now()}
                  label={formatExpiry(status.tokenExpiresAt)}
                />
              </div>
            )}

            {status.subscriptionType && (
              <div className="flex items-center justify-between">
                <span className="uppercase font-bold text-[10px]">Plan</span>
                <span className="px-1.5 py-0.5 font-bold text-[10px] bg-brutal-purple text-brutal-white uppercase">
                  {status.subscriptionType}
                </span>
              </div>
            )}

            {status.rateLimitTier && (
              <div className="flex items-center justify-between">
                <span className="uppercase font-bold text-[10px]">Rate</span>
                <span className="text-[10px] px-1.5 py-0.5 font-bold bg-brutal-blue/20">
                  {decodeRateLimitTier(status.rateLimitTier)}
                </span>
              </div>
            )}
          </div>

          {status.path && (
            <div className="flex items-center justify-between text-[10px] text-brutal-black/50">
              <span className="uppercase font-bold">Path</span>
              <span className="truncate ml-2">{status.path}</span>
            </div>
          )}

          {/* Updates + Auth: compact row of buttons */}
          <div className="border-t-2 border-brutal-black/20 pt-2 mt-1 flex gap-2">
            <button
              onClick={handleCheckUpdate}
              disabled={checking || updating}
              className="flex-1 bg-brutal-blue text-brutal-white font-bold uppercase py-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-[10px]"
            >
              {checking ? "Checking..." : "Check Updates"}
            </button>
            <button
              onClick={() => setShowSetup(!showSetup)}
              className="flex-1 bg-brutal-yellow text-brutal-black font-bold uppercase py-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-[10px]"
            >
              {showSetup ? "Hide" : status.authenticated ? "Re-Auth" : "Setup Auth"}
            </button>
          </div>

          {/* Update results */}
          {updateInfo && (
            <div>
              {updateInfo.upToDate ? (
                <p className="text-brutal-green font-bold text-[10px]">Up to date!</p>
              ) : updateInfo.updateAvailable ? (
                <div className="space-y-1">
                  <p className="text-brutal-orange font-bold text-[10px]">Update available!</p>
                  <button
                    onClick={handleInstallUpdate}
                    disabled={updating}
                    className="w-full bg-brutal-green text-brutal-black font-bold uppercase py-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-[10px]"
                  >
                    {updating ? "Installing..." : "Install Update"}
                  </button>
                </div>
              ) : null}
              <pre className="mt-1 bg-brutal-black text-brutal-green p-1.5 text-[10px] overflow-x-auto brutal-border max-h-20 overflow-y-auto leading-tight">
                {updateInfo.output}
              </pre>
            </div>
          )}

          {updateOutput && (
            <pre className="bg-brutal-black text-brutal-green p-1.5 text-[10px] overflow-x-auto brutal-border max-h-20 overflow-y-auto leading-tight">
              {updateOutput}
            </pre>
          )}

          {/* Auth setup (expandable) */}
          {showSetup && (
            <div className="bg-brutal-bg brutal-border p-3 space-y-2 text-[10px]">
              <p className="font-bold uppercase">
                {status.authenticated ? "To re-authenticate:" : "To authenticate Claude Code:"}
              </p>
              <div className="space-y-1">
                <p>1. SSH into your server:</p>
                <pre className="bg-brutal-black text-brutal-green p-1.5 brutal-border overflow-x-auto">
                  ssh ubuntu@your-server-ip
                </pre>
                <p>2. Run auth command:</p>
                <pre className="bg-brutal-black text-brutal-green p-1.5 brutal-border overflow-x-auto">
                  {status.setupCommand}
                </pre>
                <p>3. Sign in via browser.</p>
                <p>4. Restart service:</p>
                <pre className="bg-brutal-black text-brutal-green p-1.5 brutal-border overflow-x-auto">
                  sudo systemctl restart tiffbot
                </pre>
                <p className="text-brutal-black/60 italic">
                  Requires browser access via SSH.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
