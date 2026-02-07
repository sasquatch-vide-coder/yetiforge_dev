import { useState, useEffect, useCallback } from "react";

interface Backup {
  id: string;
  timestamp: string;
  files: number;
  sizeBytes: number;
}

interface Props {
  token: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return val.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function BackupPanel({ token }: Props) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchBackups = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/backup/list", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((err as Record<string, string>).error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setBackups(data.backups || []);
      setErrorMsg(null);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to fetch backups");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchBackups();
  }, [fetchBackups]);

  const handleCreate = async () => {
    setCreating(true);
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/admin/backup/create", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((err as Record<string, string>).error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setStatusMsg(`Backup created: ${data.backup.files} files, ${formatBytes(data.backup.sizeBytes)}`);
      fetchBackups();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to create backup");
    } finally {
      setCreating(false);
    }
  };

  const handleRestore = async (id: string) => {
    if (!window.confirm("Are you sure you want to restore this backup? This will overwrite current data.")) {
      return;
    }
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/admin/backup/restore", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((err as Record<string, string>).error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setStatusMsg(`Backup restored: ${data.restoredFiles.length} files restored`);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to restore backup");
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this backup permanently?")) return;
    setStatusMsg(null);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/admin/backup/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((err as Record<string, string>).error || `HTTP ${res.status}`);
      }
      setStatusMsg("Backup deleted");
      fetchBackups();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to delete backup");
    }
  };

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-4">
      <h2 className="text-sm font-bold uppercase mb-2 font-mono">Backups</h2>

      {errorMsg && (
        <p className="font-mono text-[10px] text-brutal-red mb-1">{errorMsg}</p>
      )}
      {statusMsg && (
        <p className="font-mono text-[10px] text-brutal-green font-bold mb-1">{statusMsg}</p>
      )}

      <div className="mb-2">
        <button
          onClick={handleCreate}
          disabled={creating}
          className="bg-brutal-black text-brutal-white font-bold uppercase py-1.5 px-3 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs font-mono disabled:opacity-50"
        >
          {creating ? "Creating..." : "Create Backup"}
        </button>
      </div>

      {loading ? (
        <p className="text-xs font-mono text-brutal-black/50 uppercase">Loading backups...</p>
      ) : backups.length === 0 ? (
        <p className="text-xs font-mono text-brutal-black/50 uppercase py-2 text-center">
          No backups yet
        </p>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-[10px] font-mono">
              <thead>
                <tr className="bg-brutal-black text-brutal-white uppercase">
                  <th className="text-left px-1.5 py-0.5">Date/Time</th>
                  <th className="text-left px-1.5 py-0.5">Files</th>
                  <th className="text-left px-1.5 py-0.5">Size</th>
                  <th className="text-left px-1.5 py-0.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((backup, i) => (
                  <tr
                    key={backup.id}
                    className={i % 2 === 0 ? "bg-brutal-bg" : "bg-brutal-white"}
                  >
                    <td className="px-1.5 py-0.5">{formatTime(backup.timestamp)}</td>
                    <td className="px-1.5 py-0.5">{backup.files}</td>
                    <td className="px-1.5 py-0.5">{formatBytes(backup.sizeBytes)}</td>
                    <td className="px-1.5 py-0.5">
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => handleRestore(backup.id)}
                          className="bg-brutal-blue text-brutal-white font-bold uppercase py-0.5 px-2 brutal-border text-[10px] font-mono hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none brutal-shadow transition-all"
                        >
                          Restore
                        </button>
                        <button
                          onClick={() => handleDelete(backup.id)}
                          className="bg-brutal-red text-brutal-white font-bold uppercase py-0.5 px-2 brutal-border text-[10px] font-mono hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none brutal-shadow transition-all"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card layout */}
          <div className="md:hidden space-y-2">
            {backups.map((backup) => (
              <div
                key={backup.id}
                className="bg-brutal-bg brutal-border p-2 space-y-1"
              >
                <div className="text-[10px] font-bold font-mono">
                  {formatTime(backup.timestamp)}
                </div>
                <div className="flex justify-between text-[10px] text-brutal-black/70">
                  <span>{backup.files} files</span>
                  <span>{formatBytes(backup.sizeBytes)}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleRestore(backup.id)}
                    className="flex-1 bg-brutal-blue text-brutal-white font-bold uppercase py-1.5 px-3 brutal-border text-xs font-mono hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none brutal-shadow transition-all"
                  >
                    Restore
                  </button>
                  <button
                    onClick={() => handleDelete(backup.id)}
                    className="flex-1 bg-brutal-red text-brutal-white font-bold uppercase py-1.5 px-3 brutal-border text-xs font-mono hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none brutal-shadow transition-all"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
