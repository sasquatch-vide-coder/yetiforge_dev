export type AgentTier = "chat" | "orchestrator" | "worker";

export interface WorkRequest {
  type: "work_request";
  task: string;
  context: string;
  urgency: "normal" | "quick";
}

export interface OrchestratorPlan {
  type: "plan";
  summary: string;
  workers: WorkerTask[];
  sequential: boolean;
}

export interface WorkerTask {
  id: string;
  description: string;
  prompt: string;
  dependsOn?: string[];
}

export interface WorkerResult {
  taskId: string;
  success: boolean;
  result: string;
  costUsd?: number;
  duration?: number;
}

export interface OrchestratorSummary {
  type: "summary";
  overallSuccess: boolean;
  summary: string;
  workerResults: WorkerResult[];
  totalCostUsd: number;
  /** Set to true if any worker indicates a service restart is needed */
  needsRestart?: boolean;
}

export interface StatusUpdate {
  type: "status" | "plan_breakdown" | "worker_complete";
  message: string;
  progress?: string;
  /** If true, send as a NEW Telegram message (user gets notification). Otherwise, edit the status message in-place. */
  important?: boolean;
}

export interface ChatAgentResponse {
  chatText: string;
  action: WorkRequest | null;
}
