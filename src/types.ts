export type ModelProfile = "auto" | "strong" | "balanced" | "cheap" | "local";
export type AgentProfile = "api" | "claude-code" | "codex" | "auto";

export type SessionState = {
  key: string;
  repo?: string;
  model: ModelProfile | string;
  agent: AgentProfile | string;
  summary: string;
  messages?: SessionMessage[];
  updatedAt: string;
};

export type SessionMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  at: string;
};

export type JobStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "approved"
  | "pushed"
  | "completed"
  | "failed";

export type Job = {
  id: string;
  sessionKey: string;
  channelId: string;
  threadId?: string;
  userId: string;
  repo: string;
  prompt: string;
  kind?: "change" | "analysis";
  model: string;
  agent: string;
  status: JobStatus;
  branch?: string;
  diff?: string;
  applyMode?: "patch" | "worktree";
  prUrl?: string;
  progressMessageId?: string;
  progressLabel?: string;
  progressPercent?: number;
  memoryContext?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type ModelRequest = {
  model: string;
  system: string;
  prompt: string;
};

export type ModelResponse = {
  text: string;
  provider: string;
  model: string;
};
