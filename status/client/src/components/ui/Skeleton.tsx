interface SkeletonProps {
  className?: string;
  width?: string;
  height?: string;
}

export function Skeleton({ className = "", width, height }: SkeletonProps) {
  return (
    <div
      className={`skeleton-shimmer brutal-border ${className}`}
      style={{
        width: width || "100%",
        height: height || "20px",
        minHeight: height || "20px",
      }}
    />
  );
}

interface SkeletonLinesProps {
  lines?: number;
  className?: string;
}

export function SkeletonLines({ lines = 3, className = "" }: SkeletonLinesProps) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          width={i === lines - 1 ? "60%" : "100%"}
          height="14px"
        />
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="bg-brutal-white brutal-border brutal-shadow p-6">
      <Skeleton width="40%" height="20px" />
      <div className="mt-4 space-y-3">
        <Skeleton height="32px" />
        <Skeleton height="14px" width="80%" />
        <Skeleton height="14px" width="50%" />
      </div>
    </div>
  );
}
