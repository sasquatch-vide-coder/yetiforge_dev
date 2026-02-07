interface Props {
  status: string;
  uptime: string | null;
  memory: string | null;
}

export function ServiceCard({ status, uptime, memory }: Props) {
  const isOnline = status === "active";

  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-6">
      <h2 className="text-sm uppercase tracking-widest mb-4 font-bold">
        Bot Service
      </h2>
      <div className="flex items-center gap-3 mb-4">
        <div
          className={`w-5 h-5 brutal-border ${
            isOnline ? "bg-brutal-green" : "bg-brutal-red"
          }`}
        />
        <span className="text-2xl font-bold uppercase">
          {isOnline ? "Online" : "Offline"}
        </span>
      </div>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="font-bold uppercase">Uptime</span>
          <span>{uptime || "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="font-bold uppercase">Memory</span>
          <span>{memory || "—"}</span>
        </div>
      </div>
    </div>
  );
}
