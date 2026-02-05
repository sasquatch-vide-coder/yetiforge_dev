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

export function AdminClaudePanel({ token }: Props) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showSetup, setShowSetup] = useState(false);

  // Update state
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
      // Refresh status to get new version
      fetchStatus();
    } catch (e) {
      setUpdateOutput(
        e instanceof Error ? e.message : "Failed to install update"
      );
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-6">
      <h2 className="text-lg font-bold uppercase mb-4 border-b-3 border-brutal-black pb-2">
        Claude Code
      </h2>

      {loading && <p className="font-mono text-sm">Checking status...</p>}
      {error && (
        <p className="font-mono text-sm text-brutal-red mb-2">{error}</p>
      )}

      {status && (
        <div className="space-y-3 font-mono text-sm">
          <div className="flex justify-between">
            <span className="uppercase font-bold">Installed</span>
            <span
              className={`px-2 py-0.5 font-bold ${
                status.installed
                  ? "bg-brutal-green text-brutal-black"
                  : "bg-brutal-red text-brutal-white"
              }`}
            >
              {status.installed ? "YES" : "NO"}
            </span>
          </div>

          {status.version && (
            <div className="flex justify-between">
              <span className="uppercase font-bold">Version</span>
              <span>{status.version}</span>
            </div>
          )}

          <div className="flex justify-between">
            <span className="uppercase font-bold">Authenticated</span>
            <span
              className={`px-2 py-0.5 font-bold ${
                status.authenticated
                  ? "bg-brutal-green text-brutal-black"
                  : "bg-brutal-red text-brutal-white"
              }`}
            >
              {status.authenticated ? "YES" : "NO"}
            </span>
          </div>

          {status.tokenExpiresAt && (
            <div className="flex justify-between">
              <span className="uppercase font-bold">Token Expires</span>
              <span
                className={`px-2 py-0.5 font-bold ${
                  status.tokenExpiresAt > Date.now()
                    ? "bg-brutal-green text-brutal-black"
                    : "bg-brutal-red text-brutal-white"
                }`}
              >
                {formatExpiry(status.tokenExpiresAt)}
              </span>
            </div>
          )}

          {status.subscriptionType && (
            <div className="flex justify-between">
              <span className="uppercase font-bold">Plan</span>
              <span className="px-2 py-0.5 font-bold bg-brutal-purple text-brutal-white uppercase">
                {status.subscriptionType}
              </span>
            </div>
          )}

          {status.rateLimitTier && (
            <div className="flex justify-between">
              <span className="uppercase font-bold">Rate Limit</span>
              <span className="text-xs">
                {status.rateLimitTier.replace(/_/g, " ")}
              </span>
            </div>
          )}

          {status.path && (
            <div className="flex justify-between">
              <span className="uppercase font-bold">Path</span>
              <span className="text-xs">{status.path}</span>
            </div>
          )}

          {/* Updates Section */}
          <div className="border-t-3 border-brutal-black pt-3 mt-4">
            <h3 className="font-bold uppercase text-xs mb-2">Updates</h3>

            <div className="flex gap-2">
              <button
                onClick={handleCheckUpdate}
                disabled={checking || updating}
                className="flex-1 bg-brutal-blue text-brutal-white font-bold uppercase py-2 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-xs"
              >
                {checking ? "Checking..." : "Check for Updates"}
              </button>
            </div>

            {updateInfo && (
              <div className="mt-2">
                {updateInfo.upToDate ? (
                  <p className="text-brutal-green font-bold text-xs">
                    Up to date!
                  </p>
                ) : updateInfo.updateAvailable ? (
                  <div className="space-y-2">
                    <p className="text-brutal-orange font-bold text-xs">
                      Update available!
                    </p>
                    <button
                      onClick={handleInstallUpdate}
                      disabled={updating}
                      className="w-full bg-brutal-green text-brutal-black font-bold uppercase py-2 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-xs"
                    >
                      {updating ? "Installing..." : "Install Update"}
                    </button>
                  </div>
                ) : null}
                <pre className="mt-2 bg-brutal-black text-brutal-green p-2 text-xs overflow-x-auto brutal-border max-h-32 overflow-y-auto">
                  {updateInfo.output}
                </pre>
              </div>
            )}

            {updateOutput && (
              <pre className="mt-2 bg-brutal-black text-brutal-green p-2 text-xs overflow-x-auto brutal-border max-h-32 overflow-y-auto">
                {updateOutput}
              </pre>
            )}
          </div>

          {/* Auth Section */}
          <div className="border-t-3 border-brutal-black pt-3">
            <h3 className="font-bold uppercase text-xs mb-2">
              Authentication
            </h3>

            <button
              onClick={() => setShowSetup(!showSetup)}
              className="w-full bg-brutal-yellow text-brutal-black font-bold uppercase py-2 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs"
            >
              {showSetup
                ? "Hide"
                : status.authenticated
                  ? "Re-Authenticate"
                  : "Setup Authentication"}
            </button>

            {showSetup && (
              <div className="mt-3 bg-brutal-bg brutal-border p-4 space-y-3">
                <p className="font-bold uppercase text-xs">
                  {status.authenticated
                    ? "To re-authenticate or refresh your token:"
                    : "To authenticate Claude Code:"}
                </p>
                <div className="space-y-2 text-xs">
                  <p>1. SSH into your server:</p>
                  <pre className="bg-brutal-black text-brutal-green p-2 brutal-border overflow-x-auto">
                    ssh ubuntu@your-server-ip
                  </pre>
                  <p>2. Run the authentication command:</p>
                  <pre className="bg-brutal-black text-brutal-green p-2 brutal-border overflow-x-auto">
                    {status.setupCommand}
                  </pre>
                  <p>
                    3. A browser will open — sign in with your Anthropic
                    account.
                  </p>
                  <p>4. Restart the bot service to apply:</p>
                  <pre className="bg-brutal-black text-brutal-green p-2 brutal-border overflow-x-auto">
                    sudo systemctl restart rumpbot
                  </pre>
                  <p className="text-brutal-black/60 italic">
                    Authentication requires browser access via SSH and cannot be
                    done through this web interface.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
