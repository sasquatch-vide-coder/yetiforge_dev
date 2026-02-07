import { Config } from "../config.js";
import { invokeClaude, ClaudeResult } from "../claude/invoker.js";
import { SessionManager } from "../claude/session-manager.js";
import { AgentConfigManager } from "./agent-config.js";
import { buildChatSystemPrompt } from "./prompts.js";
import type { WorkRequest, ChatAction, ChatAgentResponse } from "./types.js";
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
    /** If a plan is pending, inject marker so chat agent knows to expect approval/rejection */
    pendingPlanContext?: string;
  }): Promise<{
    chatResponse: string;
    workRequest: WorkRequest | null;
    action: ChatAction | null;
    memoryNote: string | null;
    claudeResult: ClaudeResult;
  }> {
    const tierConfig = this.agentConfig.getConfig("chat");
    const sessionId = this.sessionManager.getSessionId(opts.chatId, "chat");

    // Build the full prompt with memory context and pending plan marker
    let fullPrompt = opts.prompt;
    if (opts.pendingPlanContext) {
      fullPrompt = `[PENDING PLAN]\nThe following plan is awaiting user approval:\n\n${opts.pendingPlanContext}\n\n---\n\nUser message: ${fullPrompt}`;
    }
    if (opts.memoryContext) {
      fullPrompt = `${opts.memoryContext}\n\n---\n\n${fullPrompt}`;
    }

    const result = await invokeClaude({
      prompt: fullPrompt,
      cwd: opts.cwd,
      sessionId,
      abortSignal: opts.abortSignal,
      config: this.config,
      onInvocation: opts.onInvocation,
      systemPrompt: this.systemPrompt,
      model: tierConfig.model,
      timeoutMsOverride: tierConfig.timeoutMs,
    });

    // Save session and check for rotation
    if (result.sessionId) {
      this.sessionManager.set(opts.chatId, result.sessionId, opts.cwd, "chat");
      // Rotate session after 15 invocations to prevent unbounded context growth
      this.sessionManager.incrementAndCheck(opts.chatId, "chat", 15);
    }

    // Parse response for action blocks and memory blocks
    const parsed = parseChatResponse(result.result);

    logger.info({
      chatId: opts.chatId,
      hasAction: !!parsed.action,
      hasMemory: !!parsed.memoryNote,
      responseLength: parsed.chatText.length,
    }, "Chat agent response parsed");

    // Extract workRequest for backwards compatibility (only if action is a work_request)
    const workRequest = parsed.action?.type === "work_request" ? parsed.action as WorkRequest : null;

    return {
      chatResponse: parsed.chatText,
      workRequest,
      action: parsed.action,
      memoryNote: parsed.memoryNote,
      claudeResult: result,
    };
  }
}

interface ParsedChatResponse {
  chatText: string;
  action: ChatAction | null;
  memoryNote: string | null;
}

function parseChatResponse(text: string): ParsedChatResponse {
  const actionRegex = /<YETIFORGE_ACTION>([\s\S]*?)<\/YETIFORGE_ACTION>/;
  const memoryRegex = /<TIFFBOT_MEMORY>([\s\S]*?)<\/TIFFBOT_MEMORY>/;

  // Parse action block
  const actionMatch = text.match(actionRegex);
  let action: ChatAction | null = null;

  if (actionMatch) {
    try {
      const parsed = JSON.parse(actionMatch[1].trim());

      // Validate by type
      switch (parsed.type) {
        case "work_request":
          if (parsed.task) {
            action = parsed as WorkRequest;
          } else {
            logger.warn({ action: parsed }, "work_request missing task field, ignoring");
          }
          break;
        case "approve_plan":
          action = { type: "approve_plan" };
          break;
        case "revise_plan":
          if (parsed.feedback) {
            action = { type: "revise_plan", feedback: parsed.feedback };
          } else {
            logger.warn({ action: parsed }, "revise_plan missing feedback field, ignoring");
          }
          break;
        case "cancel_plan":
          action = { type: "cancel_plan" };
          break;
        default:
          logger.warn({ action: parsed }, "Unknown action type from chat agent, ignoring");
          break;
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
