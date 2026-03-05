// Agent runner events emitted to the orchestrator — spec Section 10.4

export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
}

interface BaseEvent {
  readonly timestamp: Date;
  readonly codex_app_server_pid: string | null;
}

export interface SessionStartedEvent extends BaseEvent {
  readonly event: "session_started";
  readonly thread_id: string;
  readonly turn_id: string;
}

export interface StartupFailedEvent extends BaseEvent {
  readonly event: "startup_failed";
  readonly error: string;
}

export interface TurnCompletedEvent extends BaseEvent {
  readonly event: "turn_completed";
  readonly turn_id: string;
  readonly usage?: TokenUsage;
}

export interface TurnFailedEvent extends BaseEvent {
  readonly event: "turn_failed";
  readonly turn_id: string;
  readonly error: string;
  readonly usage?: TokenUsage;
}

export interface TurnCancelledEvent extends BaseEvent {
  readonly event: "turn_cancelled";
  readonly turn_id: string;
}

export interface TurnEndedWithErrorEvent extends BaseEvent {
  readonly event: "turn_ended_with_error";
  readonly turn_id: string;
  readonly error: string;
}

export interface TurnInputRequiredEvent extends BaseEvent {
  readonly event: "turn_input_required";
}

export interface ApprovalAutoApprovedEvent extends BaseEvent {
  readonly event: "approval_auto_approved";
  readonly tool_name: string;
}

export interface UnsupportedToolCallEvent extends BaseEvent {
  readonly event: "unsupported_tool_call";
  readonly tool_name: string;
}

export interface NotificationEvent extends BaseEvent {
  readonly event: "notification";
  readonly message: string;
}

export interface OtherMessageEvent extends BaseEvent {
  readonly event: "other_message";
  readonly raw: unknown;
}

export interface MalformedEvent extends BaseEvent {
  readonly event: "malformed";
  readonly raw: string;
}

export interface TokenUsageUpdatedEvent extends BaseEvent {
  readonly event: "token_usage_updated";
  readonly usage: TokenUsage;
  readonly rate_limits?: unknown;
}

export type AgentEvent =
  | SessionStartedEvent
  | StartupFailedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCancelledEvent
  | TurnEndedWithErrorEvent
  | TurnInputRequiredEvent
  | ApprovalAutoApprovedEvent
  | UnsupportedToolCallEvent
  | NotificationEvent
  | OtherMessageEvent
  | MalformedEvent
  | TokenUsageUpdatedEvent;

export type AgentEventType = AgentEvent["event"];

export type AgentEventCallback = (issueId: string, event: AgentEvent) => void;
