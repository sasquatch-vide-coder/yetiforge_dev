import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

interface ShortcutInfo {
  keys: string;
  description: string;
}

const SHORTCUTS: ShortcutInfo[] = [
  { keys: "Ctrl + 1", description: "Switch to Admin tab" },
  { keys: "Ctrl + 2", description: "Switch to Chat tab" },
  { keys: "Ctrl + 3", description: "Switch to Agents tab" },
  { keys: "Ctrl + 4", description: "Switch to Dashboard tab" },
  { keys: "Ctrl + /", description: "Focus chat input" },
  { keys: "Escape", description: "Close dialog / cancel" },
];

export function KeyboardShortcutsHelp() {
  const [open, setOpen] = useState(false);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    },
    [handleClose]
  );

  useEffect(() => {
    if (!open) return;

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, handleKeyDown]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-8 h-8 brutal-border bg-brutal-white text-brutal-black font-bold font-mono text-sm flex items-center justify-center hover:bg-brutal-bg"
        aria-label="Keyboard shortcuts"
      >
        ?
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-brutal-black/50"
            onClick={handleClose}
          >
            <div
              className="bg-brutal-white brutal-border brutal-shadow-lg p-6 max-w-md w-full mx-4 relative"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={handleClose}
                className="absolute top-3 right-3 text-brutal-black/60 hover:text-brutal-black font-bold font-mono text-lg leading-none p-1"
                aria-label="Close"
              >
                &#x2715;
              </button>
              <h2 className="text-lg font-bold uppercase font-mono mb-4">
                Keyboard Shortcuts
              </h2>
              <div className="space-y-2">
                {SHORTCUTS.map((shortcut) => (
                  <div
                    key={shortcut.keys}
                    className="flex items-center justify-between gap-4"
                  >
                    <kbd className="bg-brutal-bg brutal-border px-2 py-0.5 text-xs font-mono font-bold shrink-0">
                      {shortcut.keys}
                    </kbd>
                    <span className="font-mono text-sm text-brutal-black/70 text-right">
                      {shortcut.description}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
