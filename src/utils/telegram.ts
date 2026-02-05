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
