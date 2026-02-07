import { useState, useEffect } from "react";
import { getSSLStatus, renewSSL, generateSSLCert } from "../lib/adminApi";

interface Props {
  token: string;
}

export function AdminSSLPanel({ token }: Props) {
  const [status, setStatus] = useState<{
    hasCert: boolean;
    domain: string | null;
    expiry: string | null;
    certPath: string | null;
    autoRenew: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [renewing, setRenewing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [renewOutput, setRenewOutput] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [showGenerator, setShowGenerator] = useState(false);

  useEffect(() => {
    setLoading(true);
    getSSLStatus(token)
      .then(setStatus)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  const handleRenew = async () => {
    setRenewing(true);
    setRenewOutput("");
    try {
      const result = await renewSSL(token);
      setRenewOutput(result.output);
      const updated = await getSSLStatus(token);
      setStatus(updated);
    } catch (e) {
      setRenewOutput(e instanceof Error ? e.message : "Renewal failed");
    } finally {
      setRenewing(false);
    }
  };

  const handleGenerate = async () => {
    if (!newDomain.trim()) {
      setRenewOutput("Domain is required");
      return;
    }
    setGenerating(true);
    setRenewOutput("");
    try {
      const result = await generateSSLCert(newDomain, token);
      setRenewOutput(result.output);
      setNewDomain("");
      setShowGenerator(false);
      const updated = await getSSLStatus(token);
      setStatus(updated);
    } catch (e) {
      setRenewOutput(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-4">
      <h2 className="text-sm font-bold uppercase mb-2 font-mono">SSL / TLS</h2>

      {loading && <p className="font-mono text-xs">Checking status...</p>}
      {error && <p className="font-mono text-xs text-brutal-red">{error}</p>}

      {status && (
        <div className="space-y-1 font-mono">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <div className="flex items-center justify-between col-span-2">
              <span className="uppercase font-bold text-[10px]">Certificate</span>
              <span
                className={`px-1.5 py-0.5 font-bold text-[10px] ${
                  status.hasCert
                    ? "bg-brutal-green text-brutal-black"
                    : "bg-brutal-red text-brutal-white"
                }`}
              >
                {status.hasCert ? "ACTIVE" : "NONE"}
              </span>
            </div>
            {status.domain && (
              <div className="flex items-center justify-between col-span-2">
                <span className="uppercase font-bold text-[10px]">Domain</span>
                <span className="text-[10px]">{status.domain}</span>
              </div>
            )}
            {status.expiry && (
              <div className="flex items-center justify-between col-span-2">
                <span className="uppercase font-bold text-[10px]">Expires</span>
                <span className="text-[10px]">{status.expiry}</span>
              </div>
            )}
            <div className="flex items-center justify-between col-span-2">
              <span className="uppercase font-bold text-[10px]">Auto-Renew</span>
              <span
                className={`px-1.5 py-0.5 font-bold text-[10px] ${
                  status.autoRenew
                    ? "bg-brutal-green text-brutal-black"
                    : "bg-brutal-orange text-brutal-black"
                }`}
              >
                {status.autoRenew ? "ON" : "OFF"}
              </span>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={handleRenew}
              disabled={renewing}
              className="flex-1 bg-brutal-blue text-brutal-white font-bold uppercase py-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-xs font-mono"
            >
              {renewing ? "Renewing..." : "Renew Now"}
            </button>
            <button
              onClick={() => setShowGenerator(!showGenerator)}
              className="flex-1 bg-brutal-black text-brutal-white font-bold uppercase py-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs font-mono"
            >
              {showGenerator ? "Cancel" : "New Domain"}
            </button>
          </div>

          {showGenerator && (
            <div className="border-t-2 border-brutal-black/20 pt-2 mt-1 space-y-1.5">
              <label className="block text-[10px] uppercase font-bold font-mono">Domain</label>
              <input
                type="text"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                placeholder="example.com"
                className="w-full p-1.5 brutal-border font-mono text-xs bg-brutal-bg"
              />
              <button
                onClick={handleGenerate}
                disabled={generating || !newDomain.trim()}
                className="w-full bg-brutal-green text-brutal-black font-bold uppercase py-1.5 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all disabled:opacity-50 text-xs font-mono"
              >
                {generating ? "Generating..." : "Generate Cert"}
              </button>
            </div>
          )}
        </div>
      )}

      {renewOutput && (
        <pre className="mt-2 bg-brutal-black text-brutal-green p-2 text-[10px] overflow-x-auto brutal-border max-h-32 overflow-y-auto">
          {renewOutput}
        </pre>
      )}
    </div>
  );
}
