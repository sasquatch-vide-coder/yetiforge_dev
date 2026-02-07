export type AgentTier = "chat" | "executor";

/** Execution phase: "plan" = read-only investigation, "execute" = full tool access */
export type ExecutionPhase = "plan" | "execute";

export interface WorkRequest {
  type: "work_request";
  task: string;
  context: string;
  urgency: "normal" | "quick";
  complexity?: "trivial" | "moderate" | "complex";
  /** Optional phase override. If omitted, defaults to "plan" for the initial request. */
  phase?: ExecutionPhase;
}

/** Emitted by chat agent when user approves a pending plan */
export interface ApprovePlan {
  type: "approve_plan";
}

/** Emitted by chat agent when user requests changes to a pending plan */
export interface RevisePlan {
  type: "revise_plan";
  feedback: string;
}

/** Emitted by chat agent when user cancels a pending plan */
export interface CancelPlan {
  type: "cancel_plan";
}

/** All possible action types the chat agent can emit */
export type ChatAction = WorkRequest | ApprovePlan | RevisePlan | CancelPlan;

export interface ExecutorResult {
  success: boolean;
  result: string;
  costUsd: number;
  durationMs: number;
  needsRestart: boolean;
}

export interface StatusUpdate {
  type: "status";
  message: string;
  progress?: string;
  /** If true, send as a NEW Telegram message (user gets notification). Otherwise, edit the status message in-place. */
  important?: boolean;
}

export interface ChatAgentResponse {
  chatText: string;
  action: ChatAction | null;
}

// --- Structured stream event types for Phase 1 output streaming ---

export type StreamEventType = "file_read" | "file_edit" | "file_write" | "command" | "info" | "warning" | "error";

export interface StreamEvent {
  type: StreamEventType;
  timestamp: number;
  /** File path or command string */
  detail: string;
  /** Optional extra info (e.g., command output snippet) */
  extra?: string;
}
