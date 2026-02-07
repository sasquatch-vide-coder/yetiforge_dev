import { Context } from "grammy";

const MAX_MESSAGE_LENGTH = 4096;
const TYPING_INTERVAL_MS = 4000;

export function startTypingIndicator(ctx: Context): () => void {
  let running = true;

  const sendTyping = () => {
    if (!running) return;
    ctx.replyWithChatAction("typing").catch(() => {});
  };

  sendTyping();
  const interval = setInterval(sendTyping, TYPING_INTERVAL_MS);

  return () => {
    running = false;
    clearInterval(interval);
  };
}

export function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitIndex = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitIndex < MAX_MESSAGE_LENGTH * 0.5) {
      // No good newline break; try space
      splitIndex = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    }
    if (splitIndex < MAX_MESSAGE_LENGTH * 0.5) {
      // Just hard cut
      splitIndex = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

export async function sendResponse(ctx: Context, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "Markdown" });
    } catch {
      // Markdown parse failed, send as plain text
      await ctx.reply(chunk);
    }
  }
}

export async function editMessage(
  ctx: Context,
  messageId: number,
  text: string
): Promise<void> {
  try {
    await ctx.api.editMessageText(ctx.chat!.id, messageId, text, {
      parse_mode: "Markdown",
    });
  } catch {
    // Markdown parse failed, try without parse_mode
    try {
      await ctx.api.editMessageText(ctx.chat!.id, messageId, text);
    } catch {
      // If editing fails (e.g., text is identical), silently ignore
    }
  }
}

/**
 * Safe edit that tracks last-sent text to avoid "message is not modified" errors.
 * Returns true if the edit was sent, false if skipped (identical text or error).
 */
export async function safeEditMessage(
  ctx: Context,
  messageId: number,
  text: string,
  lastText: { value: string },
): Promise<boolean> {
  // Skip if text hasn't changed
  if (text === lastText.value) return false;

  // Telegram max message length
  const truncated = text.length > 4096 ? text.slice(0, 4093) + "..." : text;

  try {
    await ctx.api.editMessageText(ctx.chat!.id, messageId, truncated, {
      parse_mode: "Markdown",
    });
    lastText.value = text;
    return true;
  } catch {
    // Markdown failed, try plain text
    try {
      await ctx.api.editMessageText(ctx.chat!.id, messageId, truncated);
      lastText.value = text;
      return true;
    } catch {
      // Silently ignore (identical text, message deleted, etc.)
      return false;
    }
  }
}
