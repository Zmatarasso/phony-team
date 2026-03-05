// Typed service configuration — spec Section 6.4

export interface TrackerConfig {
  /** Tracker kind. Currently only "jira" is supported. */
  readonly kind: "jira";
  /** Jira base URL, e.g. https://your-org.atlassian.net */
  readonly base_url: string;
  /** Jira user email for Basic auth. May be a $VAR reference. */
  readonly email: string;
  /** Jira API token for Basic auth. May be a $VAR reference. */
  readonly api_token: string;
  /** Jira space key, e.g. ZMATA */
  readonly space_key: string;
  /** Issue states considered active for dispatch. Default: ["Todo", "In Progress"] */
  readonly active_states: readonly string[];
  /** Issue states considered terminal. Default: ["Done", "Cancelled", "Closed", "Duplicate"] */
  readonly terminal_states: readonly string[];
}

export interface PollingConfig {
  /** Poll interval in milliseconds. Default: 30000 */
  readonly interval_ms: number;
}

export interface WorkspaceConfig {
  /** Root directory for all per-issue workspaces. Default: <tmpdir>/symphony_workspaces */
  readonly root: string;
}

export interface HooksConfig {
  /** Shell script run only when a workspace directory is newly created. */
  readonly after_create: string | null;
  /** Shell script run before each agent attempt. Failure aborts the attempt. */
  readonly before_run: string | null;
  /** Shell script run after each agent attempt. Failure is logged and ignored. */
  readonly after_run: string | null;
  /** Shell script run before workspace deletion. Failure is logged and ignored. */
  readonly before_remove: string | null;
  /** Timeout in ms for all hooks. Default: 60000 */
  readonly timeout_ms: number;
}

export interface AgentConfig {
  /** Maximum concurrent agent sessions globally. Default: 10 */
  readonly max_concurrent_agents: number;
  /** Maximum turns per worker session. Default: 20 */
  readonly max_turns: number;
  /** Maximum retry backoff in ms. Default: 300000 (5m) */
  readonly max_retry_backoff_ms: number;
  /** Per-state concurrency overrides. State keys are normalized (trimmed + lowercased). */
  readonly max_concurrent_agents_by_state: ReadonlyMap<string, number>;
  /** Which LLM backend to use. Default: "claude" */
  readonly backend: "claude" | "grok";
}

export interface GrokConfig {
  /** xAI API key. May be a $VAR reference. Default: $XAI_API_KEY */
  readonly api_key: string;
  /** Grok model name. Default: "grok-2-1212" */
  readonly model: string;
}

export interface CodexConfig {
  /** Shell command to launch the agent. Default: "claude --dangerously-skip-permissions" */
  readonly command: string;
  /** Total turn timeout in ms. Default: 3600000 (1h) */
  readonly turn_timeout_ms: number;
  /** Read/response timeout in ms during startup. Default: 5000 */
  readonly read_timeout_ms: number;
  /** Stall timeout in ms; <=0 disables stall detection. Default: 300000 (5m) */
  readonly stall_timeout_ms: number;
}

export interface ServerConfig {
  /** Port for optional HTTP server. Undefined means server is disabled. */
  readonly port: number | undefined;
}

export interface ServiceConfig {
  readonly tracker: TrackerConfig;
  readonly polling: PollingConfig;
  readonly workspace: WorkspaceConfig;
  readonly hooks: HooksConfig;
  readonly agent: AgentConfig;
  readonly codex: CodexConfig;
  readonly grok: GrokConfig;
  readonly server: ServerConfig;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}
