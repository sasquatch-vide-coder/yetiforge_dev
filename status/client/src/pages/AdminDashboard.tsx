import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAdminAuth } from "../hooks/useAdminAuth";
import { useStatus } from "../hooks/useStatus";
import { useBotName } from "../context/BotConfigContext";
import { AdminClaudePanel } from "../components/AdminClaudePanel";
import { AdminTelegramPanel } from "../components/AdminTelegramPanel";
import { AdminSSLPanel } from "../components/AdminSSLPanel";
import { AdminSecurityPanel } from "../components/AdminSecurityPanel";
import { AdminAgentPanel } from "../components/AdminAgentPanel";
import { AdminStallDetectionPanel } from "../components/AdminStallDetectionPanel";
import { ChatPanel } from "../components/ChatPanel";
import { AgentsPanel } from "../components/AgentsPanel";
import { ServiceCard } from "../components/ServiceCard";
import { SystemCard } from "../components/SystemCard";
import { CostCard } from "../components/CostCard";
import { CostTokenChart } from "../components/CostTokenChart";
import { ModelBreakdown } from "../components/ModelBreakdown";
import { AuditLogPanel } from "../components/AuditLogPanel";
import { SessionsPanel } from "../components/SessionsPanel";
import { BackupPanel } from "../components/BackupPanel";
import { AlertsPanel } from "../components/AlertsPanel";
import { AlertsBanner } from "../components/AlertsBanner";
import { AgentMetricsPanel } from "../components/AgentMetricsPanel";
import { SystemMetricsChart } from "../components/SystemMetricsChart";
import { KeyboardShortcutsHelp } from "../components/ui/KeyboardShortcutsHelp";
import { HelpButton } from "../components/ui/HelpModal";
import { helpContent } from "../components/ui/helpContent";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { resetChatSession } from "../lib/adminApi";

type Tab = "admin" | "chat" | "agents" | "dashboard";

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

/* ── Collapsible Section ── */
function CollapsibleSection({
  title,
  defaultOpen = false,
  helpKey,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  helpKey?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelHelp = helpKey ? helpContent[helpKey] : undefined;

  return (
    <div className="mb-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between bg-brutal-black text-brutal-white px-4 py-3 brutal-border font-bold uppercase text-sm font-mono tracking-widest min-h-[44px] touch-manipulation"
      >
        <span>{title}</span>
        <span className="text-lg leading-none">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-4 relative pb-10">
          {children}
          {panelHelp && (
            <div className="absolute bottom-0 right-0">
              <HelpButton content={panelHelp} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AdminDashboard() {
  const { token, logout } = useAdminAuth();
  const { botName } = useBotName();
  const [activeTab, setActiveTab] = useState<Tab>("admin");
  const [chatSessionKey, setChatSessionKey] = useState(0);
  const { status, invocations, loading, error, connected } = useStatus();
  const [dailyStats, setDailyStats] = useState<Array<{date: string, cost: number, totalTokens: number}>>([]);
  const [dailyStatsLoading, setDailyStatsLoading] = useState(true);
  const [lastActivity, setLastActivity] = useState<string | null>(null);

  useKeyboardShortcuts([
    { key: "1", ctrl: true, handler: () => setActiveTab("admin") },
    { key: "2", ctrl: true, handler: () => setActiveTab("chat") },
    { key: "3", ctrl: true, handler: () => setActiveTab("agents") },
    { key: "4", ctrl: true, handler: () => setActiveTab("dashboard") },
  ]);

  const fetchDailyStats = useCallback(async () => {
    try {
      const headers: HeadersInit = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/stats/daily", { headers });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setDailyStats(data);
        }
      }
    } catch {
      // Non-critical
    } finally {
      setDailyStatsLoading(false);
    }
  }, [token]);

  const fetchLastActivity = useCallback(async () => {
    try {
      const headers: HeadersInit = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/lifetime-stats", { headers });
      if (!res.ok) return;
      const data = await res.json();
      if (data.lastUpdatedAt) {
        setLastActivity(data.lastUpdatedAt);
      }
    } catch {
      // Non-critical
    }
  }, [token]);

  useEffect(() => {
    fetchDailyStats();
    fetchLastActivity();
    const timer = setInterval(fetchLastActivity, 10000);
    return () => clearInterval(timer);
  }, [fetchDailyStats, fetchLastActivity]);

  const handleReset = async () => {
    if (!token) return;
    try {
      await resetChatSession(token);
      setChatSessionKey((k) => k + 1);
    } catch {
      // Silently fail
    }
  };

  if (!token) return null;

  const tabs: { key: Tab; label: string }[] = [
    { key: "admin", label: "Admin" },
    { key: "chat", label: "Chat" },
    { key: "agents", label: "Agents" },
    { key: "dashboard", label: "Dashboard" },
  ];

  return (
    <div className="min-h-screen bg-brutal-bg p-4 md:p-10 w-full overflow-x-hidden box-border">
      {/* Header — compact on mobile */}
      <header className="mb-4 md:mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl md:text-5xl font-bold tracking-tight uppercase">
              {botName}
            </h1>
            <p className="text-xs md:text-sm mt-1 text-brutal-black/60 uppercase tracking-wide hidden md:block">
              Admin Panel
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden md:inline-block"><KeyboardShortcutsHelp /></span>
            <Link
              to="/"
              className="bg-brutal-white text-brutal-black font-bold uppercase py-2 px-3 md:px-4 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs md:text-sm font-mono min-h-[44px] inline-flex items-center touch-manipulation"
            >
              Home
            </Link>
            <button
              onClick={logout}
              className="bg-brutal-red text-brutal-white font-bold uppercase py-2 px-3 md:px-4 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs md:text-sm font-mono min-h-[44px] inline-flex items-center touch-manipulation"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <AlertsBanner />

      {/* Tab Navigation — horizontally scrollable on mobile */}
      <div className="flex mb-6 w-full max-w-full items-center overflow-x-auto scrollbar-hide -mx-4 px-4 md:mx-0 md:px-0 md:overflow-x-visible">
        <div className="flex gap-0 flex-nowrap">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`font-bold uppercase py-2 md:py-3 px-4 md:px-6 brutal-border text-xs md:text-sm font-mono transition-all whitespace-nowrap min-h-[44px] touch-manipulation flex-shrink-0 ${
                activeTab === tab.key
                  ? "bg-brutal-black text-brutal-white brutal-shadow translate-x-0 translate-y-0"
                  : "bg-brutal-white text-brutal-black hover:bg-brutal-bg"
              }`}
              style={{
                borderRight: activeTab === tab.key ? undefined : "none",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {activeTab === "chat" && (
          <button
            onClick={handleReset}
            className="ml-auto bg-brutal-orange text-brutal-white font-bold uppercase py-2 md:py-3 px-4 md:px-6 brutal-border text-xs md:text-sm font-mono brutal-shadow hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-none transition-all min-h-[44px] touch-manipulation flex-shrink-0"
          >
            New Session
          </button>
        )}
      </div>

      {/* Tab Content */}
      {activeTab === "admin" && (
        <div>
          {/* Configuration — open by default */}
          <CollapsibleSection title="Configuration" defaultOpen={true} helpKey="configuration">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <AdminAgentPanel token={token} />
              <AdminClaudePanel token={token} />
              <AdminStallDetectionPanel token={token} />
              <AdminTelegramPanel token={token} />
            </div>
          </CollapsibleSection>

          {/* Security */}
          <CollapsibleSection title="Security" helpKey="security">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <AdminSecurityPanel token={token} />
              <AdminSSLPanel token={token} />
              <SessionsPanel token={token} />
            </div>
          </CollapsibleSection>

          {/* Monitoring */}
          <CollapsibleSection title="Monitoring" helpKey="monitoring">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <AlertsPanel token={token} />
              <AuditLogPanel token={token} />
            </div>
          </CollapsibleSection>

          {/* Maintenance */}
          <CollapsibleSection title="Maintenance" helpKey="maintenance">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <BackupPanel token={token} />
            </div>
          </CollapsibleSection>
        </div>
      )}

      {activeTab === "chat" && (
        <div className="w-full max-w-full overflow-hidden">
          <ChatPanel key={chatSessionKey} token={token} />
        </div>
      )}

      {activeTab === "agents" && (
        <AgentsPanel token={token} />
      )}

      {activeTab === "dashboard" && (
        <div>
          {/* Connection status */}
          <div className="flex items-center gap-2 mb-6">
            <div
              className={`w-3 h-3 rounded-full ${
                connected ? "bg-brutal-green animate-pulse" : "bg-brutal-red"
              }`}
            />
            <span className="text-xs uppercase font-bold">
              {connected ? "Live" : "Disconnected"}
            </span>
          </div>

          {/* Loading / Error states */}
          {loading && (
            <div className="bg-brutal-yellow brutal-border brutal-shadow p-6 mb-6">
              <span className="font-bold uppercase">Loading...</span>
            </div>
          )}

          {error && !status && (
            <div className="bg-brutal-red brutal-border brutal-shadow p-6 mb-6 text-brutal-white">
              <span className="font-bold uppercase">Connection Error: </span>
              <span>{error}</span>
            </div>
          )}

          {/* Last Activity */}
          {lastActivity && (
            <div className="bg-brutal-white brutal-border brutal-shadow p-4 mb-6 flex items-center justify-between">
              <span className="text-xs uppercase font-bold tracking-widest">Last Active</span>
              <span className="text-lg font-bold">{relativeTime(lastActivity)}</span>
            </div>
          )}

          {/* Dashboard Grid */}
          {status && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <ServiceCard
                tiffbot={status.services?.tiffbot || status.service}
                nginx={status.services?.nginx || { status: "unknown", uptime: null, pid: null, memory: null }}
              />
              <SystemCard
                serverUptime={status.system.serverUptime}
                loadAvg={status.system.loadAvg}
                totalMemMB={status.system.totalMemMB}
                freeMemMB={status.system.freeMemMB}
                diskUsed={status.system.diskUsed}
                diskTotal={status.system.diskTotal}
                diskPercent={status.system.diskPercent}
              />
              <CostCard invocations={invocations} />
            </div>
          )}

          {/* Agent Metrics (merged from Costs tab) */}
          <div className="mt-6">
            <AgentMetricsPanel />
          </div>

          {/* Cost & Token Trend Chart */}
          <div className="mt-6">
            <CostTokenChart data={dailyStats} loading={dailyStatsLoading} />
          </div>

          {/* Model Breakdown */}
          <div className="mt-6">
            <ModelBreakdown />
          </div>

          {/* System Metrics */}
          <div className="mt-6">
            <SystemMetricsChart />
          </div>

          <div className="mt-6 text-center text-xs text-brutal-black/40 uppercase">
            Updated every 3s
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="mt-10 text-center text-xs text-brutal-black/40 uppercase font-mono">
        {botName} Admin
      </footer>
    </div>
  );
}
