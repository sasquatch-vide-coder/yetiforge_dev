interface ErrorBannerProps {
  message: string;
  details?: string;
  onDismiss?: () => void;
  action?: { label: string; onClick: () => void };
}

export function ErrorBanner({ message, details, onDismiss, action }: ErrorBannerProps) {
  return (
    <div className="bg-brutal-red/10 brutal-border p-4 flex items-start gap-3">
      <div className="bg-brutal-red text-brutal-white font-bold w-6 h-6 flex items-center justify-center text-xs brutal-border shrink-0">
        &#x2715;
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-mono text-sm font-bold text-brutal-red">{message}</p>
        {details && (
          <p className="font-mono text-xs text-brutal-black/60 mt-1">{details}</p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {action && (
          <button
            onClick={action.onClick}
            className="bg-brutal-black text-brutal-white text-xs font-bold uppercase py-1 px-3 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all font-mono"
          >
            {action.label}
          </button>
        )}
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-brutal-black/60 hover:text-brutal-black font-bold font-mono text-lg leading-none p-1"
            aria-label="Dismiss"
          >
            &#x2715;
          </button>
        )}
      </div>
    </div>
  );
}
