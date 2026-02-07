import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { PanelHelp } from "./helpContent";

interface HelpModalProps {
  content: PanelHelp;
}

function HelpModalDialog({
  content,
  onClose,
}: {
  content: PanelHelp;
  onClose: () => void;
}) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleKeyDown]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-brutal-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-brutal-white brutal-border brutal-shadow-lg w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between bg-brutal-black text-brutal-white px-4 py-3 flex-shrink-0">
          <h2 className="text-sm font-bold uppercase font-mono tracking-widest">
            {content.title}
          </h2>
          <button
            onClick={onClose}
            className="bg-brutal-white text-brutal-black font-bold w-7 h-7 flex items-center justify-center brutal-border hover:bg-brutal-red hover:text-brutal-white transition-colors text-sm font-mono leading-none"
            aria-label="Close"
          >
            X
          </button>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto p-4 space-y-3 flex-1">
          {content.items.map((item, i) => (
            <div key={i} className="border-b-2 border-brutal-black/10 pb-3 last:border-b-0 last:pb-0">
              <h3 className="font-bold uppercase font-mono text-[11px] text-brutal-black mb-0.5">
                {item.label}
              </h3>
              <p className="font-mono text-[11px] text-brutal-black/70 leading-relaxed">
                {item.description}
              </p>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-4 py-3 border-t-3 border-brutal-black bg-brutal-bg">
          <button
            onClick={onClose}
            className="w-full bg-brutal-black text-brutal-white font-bold uppercase py-2 brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-xs font-mono"
          >
            Got It
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function HelpButton({ content }: HelpModalProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed-help-btn bg-brutal-purple text-brutal-white font-bold w-8 h-8 flex items-center justify-center brutal-border hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none brutal-shadow transition-all text-sm font-mono cursor-pointer z-10"
        title="Help — click for setting descriptions"
        aria-label="Help"
      >
        ?
      </button>
      {open && <HelpModalDialog content={content} onClose={() => setOpen(false)} />}
    </>
  );
}
