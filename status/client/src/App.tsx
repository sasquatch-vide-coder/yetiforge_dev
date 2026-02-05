import { useStatus } from "./hooks/useStatus";
import { ServiceCard } from "./components/ServiceCard";
import { SystemCard } from "./components/SystemCard";
import { CostCard } from "./components/CostCard";

function App() {
  const { status, invocations, loading, error, connected } = useStatus();

  return (
    <div className="min-h-screen bg-brutal-bg p-6 md:p-10">
      {/* Header */}
      <header className="mb-8">
        <div className="flex items-center gap-4">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight uppercase">
            Rumpbot
          </h1>
          <div className="flex items-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${
                connected ? "bg-brutal-green animate-pulse" : "bg-brutal-red"
              }`}
            />
            <span className="text-xs uppercase font-bold">
              {connected ? "Live" : "Disconnected"}
            </span>
          </div>
        </div>
        <p className="text-sm mt-1 text-brutal-black/60 uppercase tracking-wide">
          Status Dashboard
        </p>
      </header>

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

      {/* Dashboard Grid */}
      {status && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <ServiceCard
            status={status.service.status}
            uptime={status.service.uptime}
            pid={status.service.pid}
            memory={status.service.memory}
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

      {/* Footer */}
      <footer className="mt-10 text-center text-xs text-brutal-black/40 uppercase">
        Rumpbot Status &mdash; Updated every 3s
      </footer>
    </div>
  );
}

export default App;
