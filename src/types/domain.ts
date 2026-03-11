// Core domain types — spec Section 4

export interface BlockerRef {
  readonly id: string | null;
  readonly identifier: string | null;
  readonly state: string | null;
}

export interface Issue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: number | null;
  readonly state: string;
  readonly branch_name: string | null;
  readonly url: string | null;
  readonly labels: readonly string[];
  readonly blocked_by: readonly BlockerRef[];
  readonly created_at: Date | null;
  readonly updated_at: Date | null;
}

export interface WorkflowDefinition {
  readonly config: Record<string, unknown>;
  readonly prompt_template: string;
}

export interface WorkspaceInfo {
  readonly path: string;
  readonly workspace_key: string;
  readonly created_now: boolean;
}

export type RunAttemptStatus =
  | "PreparingWorkspace"
  | "BuildingPrompt"
  | "LaunchingAgentProcess"
  | "InitializingSession"
  | "StreamingTurn"
  | "Finishing"
  | "Succeeded"
  | "Failed"
  | "TimedOut"
  | "Stalled"
  | "CanceledByReconciliation";

export interface RunAttempt {
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly attempt: number | null;
  readonly workspace_path: string;
  readonly started_at: Date;
  readonly status: RunAttemptStatus;
  readonly error?: string;
}

export interface LiveSession {
  readonly session_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly codex_app_server_pid: string | null;
  readonly last_codex_event: string | null;
  readonly last_codex_timestamp: Date | null;
  readonly last_codex_message: string | null;
  readonly codex_input_tokens: number;
  readonly codex_output_tokens: number;
  readonly codex_total_tokens: number;
  readonly last_reported_input_tokens: number;
  readonly last_reported_output_tokens: number;
  readonly last_reported_total_tokens: number;
  readonly turn_count: number;
}

export interface RetryEntry {
  readonly issue_id: string;
  readonly identifier: string;
  readonly attempt: number;
  readonly due_at_ms: number;
  readonly timer_handle: ReturnType<typeof setTimeout>;
  readonly error: string | null;
}

export interface CodexTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface RunningEntry {
  readonly issue: Issue;
  readonly identifier: string;
  readonly workspace_path: string;
  readonly session: Partial<LiveSession>;
  readonly retry_attempt: number | null;
  readonly started_at: Date;
  readonly worker_promise: Promise<void>;
  readonly abort_controller: AbortController;
}

export interface ActivityFeedEntry {
  readonly timestamp: Date;
  readonly issue_identifier: string;
  readonly turn: number;
  readonly kind: "text" | "tool_call" | "tool_result" | "thinking";
  readonly summary: string;
}

export interface OrchestratorRuntimeState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
  codex_totals: CodexTotals;
  codex_rate_limits: unknown | null;
  jira_api_calls: number;
  activity_feed: ActivityFeedEntry[];
}
