import type { StreamEvent, StreamEventType } from "../agents/types.js";

const MAX_MESSAGE_LENGTH = 4096;
const ICON_MAP: Record<StreamEventType, string> = {
  file_read: "\u{1F4C2}",   // 📂
  file_edit: "\u270F\uFE0F", // ✏️
  file_write: "\u{1F4DD}",  // 📝
  command: "\u25B6\uFE0F",  // ▶️
  info: "\u2139\uFE0F",     // ℹ️
  warning: "\u26A0\uFE0F",  // ⚠️
  error: "\u274C",           // ❌
};

/** Shorten a file path to just the last N segments for display. */
function shortPath(path: string, maxSegments = 3): string {
  const segments = path.replace(/^\/+/, "").split("/");
  if (segments.length <= maxSegments) return path;
  return ".../" + segments.slice(-maxSegments).join("/");
}

/** Format elapsed time as human readable. */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  if (minutes < 60) return remainingSec > 0 ? `${minutes}m ${remainingSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  return `${hours}h ${remainingMin}m`;
}

/**
 * StreamFormatter accumulates structured events from the executor and renders
 * a formatted progress panel for Telegram. Keeps output under 4096 chars with
 * smart truncation (shows first few + last few events when there are too many).
 */
export class StreamFormatter {
  private events: StreamEvent[] = [];
  private startTime: number;
  private taskLabel: string;
  private lastRendered = "";

  constructor(taskLabel: string) {
    this.startTime = Date.now();
    this.taskLabel = taskLabel.length > 80 ? taskLabel.slice(0, 77) + "..." : taskLabel;
  }

  /** Add a structured event. */
  addEvent(event: StreamEvent): void {
    // Deduplicate consecutive identical events
    const last = this.events[this.events.length - 1];
    if (last && last.type === event.type && last.detail === event.detail) {
      return;
    }
    this.events.push(event);
  }

  /** Convenience: add a file read event. */
  fileRead(path: string): void {
    this.addEvent({ type: "file_read", timestamp: Date.now(), detail: path });
  }

  /** Convenience: add a file edit event. */
  fileEdit(path: string): void {
    this.addEvent({ type: "file_edit", timestamp: Date.now(), detail: path });
  }

  /** Convenience: add a file write event. */
  fileWrite(path: string): void {
    this.addEvent({ type: "file_write", timestamp: Date.now(), detail: path });
  }

  /** Convenience: add a command execution event. */
  command(cmd: string, extra?: string): void {
    this.addEvent({ type: "command", timestamp: Date.now(), detail: cmd, extra });
  }

  /** Convenience: add an info event. */
  info(message: string): void {
    this.addEvent({ type: "info", timestamp: Date.now(), detail: message });
  }

  /** Convenience: add a warning event. */
  warning(message: string): void {
    this.addEvent({ type: "warning", timestamp: Date.now(), detail: message });
  }

  /** Convenience: add an error event. */
  error(message: string): void {
    this.addEvent({ type: "error", timestamp: Date.now(), detail: message });
  }

  /** Get the number of events. */
  get eventCount(): number {
    return this.events.length;
  }

  /** Render the formatted progress panel. Returns empty string if nothing changed. */
  render(forceRender = false): string {
    const rendered = this.buildPanel();
    if (!forceRender && rendered === this.lastRendered) {
      return "";
    }
    this.lastRendered = rendered;
    return rendered;
  }

  /** Always render regardless of changes. */
  renderForce(): string {
    this.lastRendered = this.buildPanel();
    return this.lastRendered;
  }

  private buildPanel(): string {
    const elapsed = formatElapsed(Date.now() - this.startTime);
    const lines: string[] = [];

    // Header with timer
    lines.push(`\u2699\uFE0F Working \u2014 ${elapsed}`);
    lines.push("");

    if (this.events.length === 0) {
      lines.push("Starting up...");
      return lines.join("\n");
    }

    // Categorize events for summary counts
    const counts = this.countByType();
    const summaryParts: string[] = [];
    if (counts.file_read > 0) summaryParts.push(`${ICON_MAP.file_read} ${counts.file_read} read`);
    if (counts.file_edit > 0) summaryParts.push(`${ICON_MAP.file_edit} ${counts.file_edit} edited`);
    if (counts.file_write > 0) summaryParts.push(`${ICON_MAP.file_write} ${counts.file_write} written`);
    if (counts.command > 0) summaryParts.push(`${ICON_MAP.command} ${counts.command} commands`);

    if (summaryParts.length > 0) {
      lines.push(summaryParts.join("  "));
      lines.push("");
    }

    // Render event log with smart truncation
    const eventLines = this.renderEvents();
    lines.push(...eventLines);

    // Join and enforce the 4096 limit
    let panel = lines.join("\n");
    if (panel.length > MAX_MESSAGE_LENGTH - 50) {
      // Hard truncate as safety net — trim events from the middle
      panel = this.buildTruncatedPanel(elapsed, counts, summaryParts);
    }

    return panel;
  }

  private renderEvents(): string[] {
    const lines: string[] = [];
    const MAX_EVENT_LINES = 30;

    if (this.events.length <= MAX_EVENT_LINES) {
      for (const event of this.events) {
        lines.push(this.formatEvent(event));
      }
    } else {
      // Smart truncation: show first 5, ellipsis, last 20
      const headCount = 5;
      const tailCount = 20;
      const skipped = this.events.length - headCount - tailCount;

      for (let i = 0; i < headCount; i++) {
        lines.push(this.formatEvent(this.events[i]));
      }
      lines.push(`   ... ${skipped} more events ...`);
      for (let i = this.events.length - tailCount; i < this.events.length; i++) {
        lines.push(this.formatEvent(this.events[i]));
      }
    }

    return lines;
  }

  private formatEvent(event: StreamEvent): string {
    const icon = ICON_MAP[event.type] || "\u2022";
    let detail = event.detail;

    // Shorten file paths
    if (event.type === "file_read" || event.type === "file_edit" || event.type === "file_write") {
      detail = shortPath(detail);
    }

    // Truncate long details
    if (detail.length > 70) {
      detail = detail.slice(0, 67) + "...";
    }

    let line = `${icon} ${detail}`;

    // Add extra info for commands (truncated)
    if (event.extra) {
      const extra = event.extra.length > 50 ? event.extra.slice(0, 47) + "..." : event.extra;
      line += ` \u2014 ${extra}`;
    }

    return line;
  }

  private buildTruncatedPanel(elapsed: string, counts: Record<string, number>, summaryParts: string[]): string {
    const lines: string[] = [];
    lines.push(`\u2699\uFE0F Working \u2014 ${elapsed}`);
    lines.push("");

    if (summaryParts.length > 0) {
      lines.push(summaryParts.join("  "));
      lines.push("");
    }

    // Only show last N events that fit
    const headerSize = lines.join("\n").length;
    const budget = MAX_MESSAGE_LENGTH - headerSize - 100; // margin

    const recentEvents: string[] = [];
    let totalLen = 0;

    // Walk backwards from the end
    for (let i = this.events.length - 1; i >= 0; i--) {
      const formatted = this.formatEvent(this.events[i]);
      if (totalLen + formatted.length + 1 > budget) break;
      recentEvents.unshift(formatted);
      totalLen += formatted.length + 1;
    }

    const skipped = this.events.length - recentEvents.length;
    if (skipped > 0) {
      lines.push(`   ... ${skipped} earlier events omitted ...`);
    }
    lines.push(...recentEvents);

    return lines.join("\n");
  }

  private countByType(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of this.events) {
      counts[event.type] = (counts[event.type] || 0) + 1;
    }
    return counts;
  }
}
