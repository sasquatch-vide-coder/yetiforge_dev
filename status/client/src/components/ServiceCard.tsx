interface ServiceStatus {
  status: string;
  uptime: string | null;
  pid: number | null;
  memory: string | null;
}

interface Props {
  tiffbot: ServiceStatus;
  nginx: ServiceStatus;
}

function ServiceEntry({
  label,
  description,
  service,
}: {
  label: string;
  description: string;
  service: ServiceStatus;
}) {
  const isOnline = service.status === "active";

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <div
          className={`w-4 h-4 brutal-border ${
            isOnline ? "bg-brutal-green" : "bg-brutal-red"
          }`}
        />
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold uppercase">{label}</span>
          <span className="text-xs text-brutal-black/50 uppercase">{description}</span>
        </div>
        <span className="ml-auto text-sm font-bold uppercase">
          {isOnline ? "Online" : "Offline"}
        </span>
      </div>
      <div className="ml-7 space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="font-bold uppercase">Uptime</span>
          <span>{service.uptime || "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="font-bold uppercase">Memory</span>
          <span>{service.memory || "—"}</span>
        </div>
      </div>
    </div>
  );
}

export function ServiceCard({ tiffbot, nginx }: Props) {
  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-6">
      <h2 className="text-sm uppercase tracking-widest mb-4 font-bold">
        Server Services
      </h2>
      <div className="space-y-4">
        <ServiceEntry
          label="tiffbot"
          description="Bot / API"
          service={tiffbot}
        />
        <hr className="border-brutal-black/20" />
        <ServiceEntry
          label="nginx"
          description="Web Server / UI"
          service={nginx}
        />
      </div>
    </div>
  );
}
