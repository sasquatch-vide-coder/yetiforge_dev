import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface DataPoint {
  date: string;
  cost: number;
  totalTokens: number;
}

interface Props {
  data: DataPoint[];
  loading?: boolean;
}

function formatDateTick(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatCostTick(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatTokenTick(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatTokensWithCommas(n: number): string {
  return n.toLocaleString();
}

interface TooltipPayloadEntry {
  dataKey: string;
  value: number;
  color: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;

  const costEntry = payload.find((p) => p.dataKey === "cost");
  const tokenEntry = payload.find((p) => p.dataKey === "totalTokens");

  return (
    <div
      style={{
        background: "#000",
        color: "#fff",
        border: "3px solid #fff",
        padding: "12px 16px",
        fontFamily: "monospace",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: 8, fontSize: 13 }}>
        {label ? formatDateTick(label) : ""}
      </div>
      {costEntry && (
        <div style={{ color: "#ff6b6b", fontSize: 12, marginBottom: 4 }}>
          COST: ${costEntry.value.toFixed(4)}
        </div>
      )}
      {tokenEntry && (
        <div style={{ color: "#339af0", fontSize: 12 }}>
          TOKENS: {formatTokensWithCommas(tokenEntry.value)}
        </div>
      )}
    </div>
  );
}

export function CostTokenChart({ data, loading }: Props) {
  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-6">
      <h2
        className="text-sm uppercase tracking-widest mb-4 font-bold"
        style={{ borderBottom: "3px solid var(--color-brutal-black)", paddingBottom: 12 }}
      >
        Cost & Tokens // 30 Day Trend
      </h2>

      {loading ? (
        <div className="flex items-center justify-center" style={{ height: 350 }}>
          <span className="text-sm uppercase font-bold tracking-widest text-brutal-black/50">
            Loading chart data...
          </span>
        </div>
      ) : data.length === 0 ? (
        <div className="flex items-center justify-center" style={{ height: 350 }}>
          <span className="text-sm uppercase font-bold tracking-widest text-brutal-black/50">
            No data available
          </span>
        </div>
      ) : (
        <>
          {/* Legend */}
          <div className="flex gap-6 mb-4 text-xs uppercase font-bold tracking-widest">
            <div className="flex items-center gap-2">
              <span
                style={{
                  display: "inline-block",
                  width: 16,
                  height: 4,
                  background: "#ff6b6b",
                }}
              />
              <span>Cost (USD)</span>
            </div>
            <div className="flex items-center gap-2">
              <span
                style={{
                  display: "inline-block",
                  width: 16,
                  height: 4,
                  background: "#339af0",
                }}
              />
              <span>Tokens</span>
            </div>
          </div>

          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />

              <XAxis
                dataKey="date"
                tickFormatter={formatDateTick}
                tick={{ fontSize: 11, fontFamily: "monospace" }}
                stroke="#1a1a1a"
                strokeWidth={2}
              />

              <YAxis
                yAxisId="left"
                tickFormatter={formatCostTick}
                tick={{ fontSize: 11, fontFamily: "monospace" }}
                stroke="#ff6b6b"
                strokeWidth={2}
                width={70}
              />

              <YAxis
                yAxisId="right"
                orientation="right"
                tickFormatter={formatTokenTick}
                tick={{ fontSize: 11, fontFamily: "monospace" }}
                stroke="#339af0"
                strokeWidth={2}
                width={65}
              />

              <Tooltip content={<CustomTooltip />} />

              <Line
                yAxisId="left"
                type="monotone"
                dataKey="cost"
                stroke="#ff6b6b"
                strokeWidth={3}
                dot={{ fill: "#ff6b6b", stroke: "#1a1a1a", strokeWidth: 2, r: 4 }}
                activeDot={{ fill: "#ff6b6b", stroke: "#1a1a1a", strokeWidth: 2, r: 6 }}
              />

              <Line
                yAxisId="right"
                type="monotone"
                dataKey="totalTokens"
                stroke="#339af0"
                strokeWidth={3}
                dot={{ fill: "#339af0", stroke: "#1a1a1a", strokeWidth: 2, r: 4 }}
                activeDot={{ fill: "#339af0", stroke: "#1a1a1a", strokeWidth: 2, r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </>
      )}
    </div>
  );
}
