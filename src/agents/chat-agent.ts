import { Config } from "../config.js";
import { invokeClaude, ClaudeResult } from "../claude/invoker.js";
import { SessionManager } from "../claude/session-manager.js";
import { AgentConfigManager } from "./agent-config.js";
import { buildChatSystemPrompt } from "./prompts.js";
import type { WorkRequest, ChatAgentResponse } from "./types.js";
import { logger } from "../utils/logger.js";

export class ChatAgent {
  private systemPrompt: string;

  constructor(
    private config: Config,
    private agentConfig: AgentConfigManager,
    private sessionManager: SessionManager,
    personalityMd: string,
  ) {
    this.systemPrompt = buildChatSystemPrompt(personalityMd);
  }

  async invoke(opts: {
    chatId: number;
    prompt: string;
    cwd: string;
    abortSignal?: AbortSignal;
    onInvocation?: (raw: any) => void;
    memoryContext?: string;
  }): Promise<{
    chatResponse: string;
    workRequest: WorkRequest | null;
    memoryNote: string | null;
    claudeResult: ClaudeResult;
  }> {
    const tierConfig = this.agentConfig.getConfig("chat");
    const sessionId = this.sessionManager.getSessionId(opts.chatId, "chat");

    // Inject memory context as prefix to the user prompt
    const fullPrompt = opts.memoryContext
      ? `${opts.memoryContext}\n\n---\n\nUser message: ${opts.prompt}`
      : opts.prompt;

    const result = await invokeClaude({
      prompt: fullPrompt,
      cwd: opts.cwd,
      sessionId,
      abortSignal: opts.abortSignal,
      config: this.config,
      onInvocation: opts.onInvocation,
      systemPrompt: this.systemPrompt,
      model: tierConfig.model,
      maxTurnsOverride: tierConfig.maxTurns,
      timeoutMsOverride: tierConfig.timeoutMs,
    });

    // Save session
    if (result.sessionId) {
      this.sessionManager.set(opts.chatId, result.sessionId, opts.cwd, "chat");
    }

    // Parse response for action blocks and memory blocks
    const parsed = parseChatResponse(result.result);

    logger.info({
      chatId: opts.chatId,
      hasAction: !!parsed.action,
      hasMemory: !!parsed.memoryNote,
      responseLength: parsed.chatText.length,
    }, "Chat agent response parsed");

    return {
      chatResponse: parsed.chatText,
      workRequest: parsed.action,
      memoryNote: parsed.memoryNote,
      claudeResult: result,
    };
  }
}

interface ParsedChatResponse extends ChatAgentResponse {
  memoryNote: string | null;
}

function parseChatResponse(text: string): ParsedChatResponse {
  const actionRegex = /<RUMPBOT_ACTION>([\s\S]*?)<\/RUMPBOT_ACTION>/;
  const memoryRegex = /<TIFFBOT_MEMORY>([\s\S]*?)<\/TIFFBOT_MEMORY>/;

  // Parse action block
  const actionMatch = text.match(actionRegex);
  let action: WorkRequest | null = null;

  if (actionMatch) {
    try {
      const parsed = JSON.parse(actionMatch[1].trim()) as WorkRequest;
      if (parsed.type === "work_request" && parsed.task) {
        action = parsed;
      } else {
        logger.warn({ action: parsed }, "Invalid action block from chat agent, ignoring");
      }
    } catch (err) {
      logger.warn({ err, raw: actionMatch[1] }, "Failed to parse action block JSON");
    }
  }

  // Parse memory block
  const memoryMatch = text.match(memoryRegex);
  const memoryNote = memoryMatch ? memoryMatch[1].trim() : null;

  // Strip both blocks from chat text
  const chatText = text
    .replace(actionRegex, "")
    .replace(memoryRegex, "")
    .trim();

  return {
    chatText: chatText || "Working on it...",
    action,
    memoryNote,
  };
}
