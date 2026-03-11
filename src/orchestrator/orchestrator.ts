import type { ServiceConfig } from "../types/config.js";
import type { Issue, OrchestratorRuntimeState, RunningEntry, RetryEntry } from "../types/domain.js";
import type { AgentEventCallback, AgentEvent } from "../types/events.js";
import type { WorkflowDefinition } from "../types/domain.js";
import type { Logger } from "../logging/logger.js";
import { JiraAdapter } from "../tracker/jiraAdapter.js";
import { JiraClient } from "../tracker/jiraClient.js";
import { RateLimitError } from "../types/errors.js";
import { WorkspaceManager, getWorkspacePath } from "../workspace/workspaceManager.js";
import { AgentRunner } from "../agent/claudeRunner.js";
import { GrokRunner } from "../agent/grokRunner.js";
import { buildPrompt } from "../agent/promptBuilder.js";
import { TokenTracker } from "../logging/tokenTracker.js";

export interface OrchestratorOptions {
  readonly config: ServiceConfig;
  readonly workflow: WorkflowDefinition;
  readonly logger: Logger;
  /** Anthropic API key for Claude backend sessions */
  readonly anthropicApiKey: string;
  /** xAI API key for Grok backend sessions (required when agent.backend === "grok") */
  readonly xaiApiKey?: string;
  /** Optional overrides for testing */
  readonly _adapter?: JiraAdapter;
  readonly _workspaceManager?: WorkspaceManager;
  readonly _runnerFactory?: RunnerFactory;
}

/** Factory function to create an AgentRunner — injectable for testing. */
export type RunnerFactory = (
  issue: Issue,
  attempt: number | null,
  workspacePath: string,
  systemPrompt: string,
  onEvent: AgentEventCallback,
  signal: AbortSignal,
) => { run(): Promise<void> };

export type StateListener = (state: Readonly<OrchestratorRuntimeState>) => void;

/** Minimum delay between reconciliation fetches on failure, ms */
const RECONCILE_FAILURE_BACKOFF_MS = 5_000;
/** Fixed continuation retry delay when a session ends without error, ms */
const CONTINUATION_RETRY_MS = 1_000;

export function retryBackoffMs(attempt: number, maxMs: number): number {
  return Math.min(10_000 * Math.pow(2, attempt - 1), maxMs);
}

export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    // priority asc, null last
    if (a.priority !== b.priority) {
      if (a.priority === null) return 1;
      if (b.priority === null) return -1;
      return a.priority - b.priority;
    }
    // created_at asc, null last
    const aTime = a.created_at?.getTime() ?? Infinity;
    const bTime = b.created_at?.getTime() ?? Infinity;
    if (aTime !== bTime) return aTime - bTime;
    // identifier lex
    return a.identifier.localeCompare(b.identifier);
  });
}

export class Orchestrator {
  private readonly state: OrchestratorRuntimeState;
  private readonly adapter: JiraAdapter;
  private readonly jiraClient: JiraClient;
  private readonly workspaceManager: WorkspaceManager;
  private readonly runnerFactory: RunnerFactory;
  private readonly listeners: Set<StateListener> = new Set();
  private readonly tokenTracker: TokenTracker = new TokenTracker();

  private workflow: WorkflowDefinition;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private stopResolve: (() => void) | null = null;
  private readonly stopPromise: Promise<void>;

  constructor(private readonly options: OrchestratorOptions) {
    const { config, workflow } = options;
    this.workflow = workflow;
    this.state = {
      poll_interval_ms: config.polling.interval_ms,
      max_concurrent_agents: config.agent.max_concurrent_agents,
      running: new Map(),
      claimed: new Set(),
      retry_attempts: new Map(),
      completed: new Set(),
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
      codex_rate_limits: null,
      jira_api_calls: 0,
      activity_feed: [],
    };
    const onJiraRequest = (method: string, path: string): void => {
      this.state.jira_api_calls++;
      options.logger.info(`Jira API call #${this.state.jira_api_calls}`, { method, path });
    };
    this.adapter = options._adapter ?? new JiraAdapter(config.tracker, onJiraRequest);
    this.jiraClient = new JiraClient({
      baseUrl: config.tracker.base_url,
      email: config.tracker.email,
      apiToken: config.tracker.api_token,
      onRequest: onJiraRequest,
    });
    this.workspaceManager = options._workspaceManager ?? new WorkspaceManager(
      config.workspace,
      config.hooks,
    );
    this.runnerFactory = options._runnerFactory ?? this.defaultRunnerFactory.bind(this);
    let res!: () => void;
    this.stopPromise = new Promise<void>((r) => { res = r; });
    this.stopResolve = res;
  }

  /** Update the active workflow (called by watcher on reload). */
  updateWorkflow(workflow: WorkflowDefinition): void {
    this.workflow = workflow;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Run terminal workspace cleanup, then start the poll loop. */
  async start(): Promise<void> {
    await this.startupCleanup();
    this.schedulePoll(0);
  }

  /** Signal the orchestrator to stop accepting new dispatches and wait for workers. */
  async stop(gracefulTimeoutMs = 30_000): Promise<void> {
    this.stopping = true;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Cancel all retry timers
    for (const entry of this.state.retry_attempts.values()) {
      clearTimeout(entry.timer_handle);
    }
    this.state.retry_attempts.clear();

    if (this.state.running.size === 0) {
      this.stopResolve?.();
      return this.stopPromise;
    }

    // Abort all running workers
    for (const entry of this.state.running.values()) {
      entry.abort_controller.abort();
    }

    // Wait for workers to finish, with timeout
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, gracefulTimeoutMs));
    await Promise.race([this.stopPromise, timeout]);
  }

  getState(): Readonly<OrchestratorRuntimeState> {
    return this.state;
  }

  getTokenTracker(): TokenTracker {
    return this.tokenTracker;
  }

  // --- Private ---

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // listener failures must not crash orchestration
      }
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;

    let rateLimitMs: number | null = null;

    try {
      await this.reconcile();
    } catch (err) {
      if (err instanceof RateLimitError) {
        rateLimitMs = err.retryAfterMs;
      }
      this.options.logger.warn("Reconciliation failed", { error: String(err) });
    }

    try {
      await this.dispatch();
    } catch (err) {
      if (err instanceof RateLimitError) {
        rateLimitMs = Math.max(rateLimitMs ?? 0, err.retryAfterMs);
      }
      this.options.logger.warn("Dispatch failed", { error: String(err) });
    }

    this.notifyListeners();
    const nextPollMs = rateLimitMs !== null
      ? Math.max(rateLimitMs, this.state.poll_interval_ms)
      : this.state.poll_interval_ms;
    if (rateLimitMs !== null) {
      this.options.logger.warn(`Rate limited — next poll in ${nextPollMs / 1000}s`);
    }
    this.schedulePoll(nextPollMs);
  }

  private async startupCleanup(): Promise<void> {
    try {
      const terminal = await this.adapter.fetchIssuesByStates(
        this.options.config.tracker.terminal_states,
      );
      for (const issue of terminal) {
        try {
          await this.workspaceManager.removeWorkspace(issue.identifier);
        } catch (err) {
          this.options.logger.warn("Failed to remove workspace during startup cleanup", {
            issue_identifier: issue.identifier,
            error: String(err),
          });
        }
      }
    } catch (err) {
      this.options.logger.warn("Startup terminal cleanup failed", { error: String(err) });
    }
  }

  private async reconcile(): Promise<void> {
    const { config, logger } = this.options;

    // Part A: stall detection
    if (config.codex.stall_timeout_ms > 0) {
      const now = Date.now();
      for (const [issueId, entry] of this.state.running) {
        const lastActivity = entry.session.last_codex_timestamp?.getTime() ?? entry.started_at.getTime();
        if (now - lastActivity > config.codex.stall_timeout_ms) {
          logger.warn("Stalled agent detected, terminating", {
            issue_id: issueId,
            issue_identifier: entry.identifier,
          });
          entry.abort_controller.abort();
          // Worker exit handler will schedule retry
        }
      }
    }

    // Part B: state reconciliation
    if (this.state.running.size === 0) return;

    const runningIds = Array.from(this.state.running.keys());
    let currentStates: Pick<Issue, "id" | "identifier" | "state">[];
    try {
      currentStates = await this.adapter.fetchIssueStatesByIds(runningIds);
    } catch (err) {
      logger.warn("State reconciliation fetch failed, keeping workers running", {
        error: String(err),
      });
      return;
    }

    const stateMap = new Map(currentStates.map((s) => [s.id, s.state]));
    for (const [issueId, entry] of this.state.running) {
      const currentState = stateMap.get(issueId);
      if (currentState === undefined) {
        // Not found in tracker — terminate without workspace cleanup
        logger.info("Issue no longer in tracker, terminating agent", {
          issue_id: issueId,
          issue_identifier: entry.identifier,
        });
        entry.abort_controller.abort();
      } else if (config.tracker.terminal_states.includes(currentState)) {
        // Terminal — terminate and clean up workspace
        logger.info("Issue reached terminal state, terminating agent", {
          issue_id: issueId,
          issue_identifier: entry.identifier,
          state: currentState,
        });
        entry.abort_controller.abort();
        void this.workspaceManager.removeWorkspace(entry.identifier).catch((err) => {
          logger.warn("Failed to remove workspace after terminal state", {
            issue_identifier: entry.identifier,
            error: String(err),
          });
        });
      }
      // Active state: no action needed
    }
  }

  private async dispatch(): Promise<void> {
    const { config, logger } = this.options;

    let candidates: Issue[];
    try {
      candidates = await this.adapter.fetchCandidateIssues();
    } catch (err) {
      logger.warn("Failed to fetch candidate issues", { error: String(err) });
      return;
    }

    const eligible = sortIssues(candidates).filter((issue) => this.shouldDispatch(issue));

    if (candidates.length === 0) {
      logger.info("Poll: no issues found in active states", {
        space_key: config.tracker.space_key,
        active_states: config.tracker.active_states.join(", "),
      });
      try {
        const all = await this.adapter.fetchAllIssues();
        if (all.length === 0) {
          logger.info("Poll debug: no issues visible via API — check that JIRA_EMAIL has access to this space and that the space_key is correct", {
            space_key: config.tracker.space_key,
            base_url: config.tracker.base_url,
            email: config.tracker.email,
          });
        } else {
          logger.info("Poll debug: issues in space (all states)", {
            issues: all.map((i) => `${i.identifier} — "${i.state}"`).join(", "),
          });
        }
      } catch (err) {
        logger.info("Poll debug: unfiltered fetch failed", { error: String(err) });
      }
    } else if (eligible.length === 0) {
      logger.info("Poll: issues found but none eligible for dispatch", {
        found: candidates.length,
        identifiers: candidates.map((i) => `${i.identifier} (${i.state})`).join(", "),
        running: this.state.running.size,
        max_concurrent_agents: this.state.max_concurrent_agents,
      });
    } else {
      logger.info("Poll: dispatching issues", {
        eligible: eligible.length,
        identifiers: eligible.map((i) => i.identifier).join(", "),
      });
    }

    for (const issue of eligible) {
      if (!this.hasGlobalSlot()) break;
      if (!this.hasStateSlot(issue.state)) continue;

      this.state.claimed.add(issue.id);
      this.spawnWorker(issue, null);
    }
  }

  private shouldDispatch(issue: Issue): boolean {
    const { config } = this.options;

    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (!config.tracker.active_states.includes(issue.state)) return false;
    if (config.tracker.terminal_states.includes(issue.state)) return false;
    if (this.state.running.has(issue.id)) return false;
    if (this.state.claimed.has(issue.id)) return false;
    if (!this.hasGlobalSlot()) return false;
    if (!this.hasStateSlot(issue.state)) return false;

    // Blocker rule: "todo" state issues must have all blockers resolved
    if (issue.state.trim().toLowerCase() === "todo") {
      for (const blocker of issue.blocked_by) {
        if (
          blocker.state !== null &&
          !config.tracker.terminal_states.includes(blocker.state)
        ) {
          return false;
        }
      }
    }

    return true;
  }

  private hasGlobalSlot(): boolean {
    return this.state.running.size < this.state.max_concurrent_agents;
  }

  private hasStateSlot(state: string): boolean {
    const key = state.trim().toLowerCase();
    const limit = this.options.config.agent.max_concurrent_agents_by_state.get(key);
    if (limit === undefined) return true;
    let count = 0;
    for (const entry of this.state.running.values()) {
      if (entry.issue.state.trim().toLowerCase() === key) count++;
    }
    return count < limit;
  }

  private spawnWorker(issue: Issue, retryAttempt: number | null): void {
    const { logger } = this.options;
    const abortController = new AbortController();
    const startedAt = new Date();

    const workerPromise = this.runAgentAttempt(issue, retryAttempt, abortController.signal);

    const entry: RunningEntry = {
      issue,
      identifier: issue.identifier,
      workspace_path: getWorkspacePath(this.options.config.workspace.root, issue.identifier),
      session: {},
      retry_attempt: retryAttempt,
      started_at: startedAt,
      worker_promise: workerPromise,
      abort_controller: abortController,
    };

    this.state.running.set(issue.id, entry);
    this.notifyListeners();

    workerPromise.then(
      () => this.onWorkerExit(issue, null, retryAttempt, startedAt),
      (err: unknown) => this.onWorkerExit(issue, err, retryAttempt, startedAt),
    );
  }

  private defaultRunnerFactory(
    issue: Issue,
    attempt: number | null,
    workspacePath: string,
    systemPrompt: string,
    onEvent: AgentEventCallback,
    signal: AbortSignal,
  ): { run(): Promise<void> } {
    const { config, logger, anthropicApiKey, xaiApiKey } = this.options;
    const childLogger = logger.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    const runnerOptions = {
      config,
      apiKey: config.agent.backend === "grok" ? (xaiApiKey ?? config.grok.api_key) : anthropicApiKey,
      workspacePath,
      issue,
      systemPrompt,
      attempt,
      onEvent,
      logger: childLogger,
      signal,
      jiraClient: this.jiraClient,
    };
    if (config.agent.backend === "grok") {
      return new GrokRunner(runnerOptions);
    }
    return new AgentRunner(runnerOptions);
  }

  private async runAgentAttempt(
    issue: Issue,
    attempt: number | null,
    signal: AbortSignal,
  ): Promise<void> {
    const { config, workflow } = this.options;

    const workspaceInfo = await this.workspaceManager.ensureWorkspace(issue.identifier);

    if (config.hooks.before_run) {
      await this.workspaceManager.runBeforeHook(workspaceInfo.path);
    }

    const systemPrompt = buildPrompt(workflow.prompt_template, issue, attempt);

    const onEvent: AgentEventCallback = (issueId, event) => {
      this.handleAgentEvent(issueId, event);
    };

    const runner = this.runnerFactory(issue, attempt, workspaceInfo.path, systemPrompt, onEvent, signal);

    try {
      await runner.run();
    } finally {
      if (config.hooks.after_run) {
        await this.workspaceManager.runAfterHook(workspaceInfo.path);
      }
    }
  }

  private handleAgentEvent(issueId: string, event: AgentEvent): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    const updatedSession = {
      ...entry.session,
      last_codex_event: event.event,
      last_codex_timestamp: event.timestamp,
    };

    if (event.event === "agent_activity") {
      const MAX_FEED_ENTRIES = 50;
      this.state.activity_feed.push({
        timestamp: event.timestamp,
        issue_identifier: entry.identifier,
        turn: event.turn,
        kind: event.kind,
        summary: event.summary,
      });
      if (this.state.activity_feed.length > MAX_FEED_ENTRIES) {
        this.state.activity_feed = this.state.activity_feed.slice(-MAX_FEED_ENTRIES);
      }
    }

    if (event.event === "token_usage_updated") {
      const prevInput = entry.session.codex_input_tokens ?? 0;
      const prevOutput = entry.session.codex_output_tokens ?? 0;
      const deltaInput = event.usage.input_tokens - prevInput;
      const deltaOutput = event.usage.output_tokens - prevOutput;

      updatedSession.codex_input_tokens = event.usage.input_tokens;
      updatedSession.codex_output_tokens = event.usage.output_tokens;
      updatedSession.codex_total_tokens = event.usage.total_tokens;

      // Recompute global totals as sum across all running sessions
      let totalInput = 0;
      let totalOutput = 0;
      for (const [id, e] of this.state.running) {
        const tokens = id === issueId ? event.usage : {
          input_tokens: e.session.codex_input_tokens ?? 0,
          output_tokens: e.session.codex_output_tokens ?? 0,
        };
        totalInput += tokens.input_tokens;
        totalOutput += tokens.output_tokens;
      }
      this.state.codex_totals.input_tokens = totalInput;
      this.state.codex_totals.output_tokens = totalOutput;
      this.state.codex_totals.total_tokens = totalInput + totalOutput;

      // Persist delta to daily token usage file (fire-and-forget)
      this.tokenTracker.recordTokens(deltaInput, deltaOutput).catch(() => undefined);
    }

    const updatedEntry: RunningEntry = { ...entry, session: updatedSession };
    this.state.running.set(issueId, updatedEntry);
    this.notifyListeners();
  }

  private onWorkerExit(
    issue: Issue,
    err: unknown,
    retryAttempt: number | null,
    startedAt: Date,
  ): void {
    const { config, logger } = this.options;

    const elapsedSeconds = (Date.now() - startedAt.getTime()) / 1000;
    this.state.codex_totals.seconds_running += elapsedSeconds;

    this.state.running.delete(issue.id);
    this.state.claimed.delete(issue.id);

    if (this.stopping) {
      if (this.state.running.size === 0) {
        this.stopResolve?.();
      }
      return; // Never schedule retries while stopping
    }

    if (err === null) {
      // Normal exit — trigger a fresh poll to re-fetch current state from Jira
      // before deciding whether to re-dispatch. This prevents re-spawning agents
      // on tickets the agent has already transitioned to a non-active state.
      logger.info("Agent session completed, triggering fresh poll", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      });
      this.schedulePoll(CONTINUATION_RETRY_MS);
    } else {
      // Error exit — exponential backoff
      const nextAttempt = (retryAttempt ?? 0) + 1;
      const delay = retryBackoffMs(nextAttempt, config.agent.max_retry_backoff_ms);
      logger.warn("Agent session failed, scheduling retry", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        attempt: nextAttempt,
        delay_ms: delay,
        error: String(err),
      });
      this.scheduleRetry(issue, nextAttempt, delay);
    }

    this.notifyListeners();
  }

  private scheduleRetry(issue: Issue, attempt: number, delayMs: number): void {
    const { config, logger } = this.options;
    const timerHandle = setTimeout(() => {
      this.state.retry_attempts.delete(issue.id);
      if (!this.stopping) {
        if (!config.tracker.active_states.includes(issue.state)) {
          logger.warn("Skipping retry — issue is no longer in an active state", {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            state: issue.state,
            active_states: config.tracker.active_states.join(", "),
          });
          this.state.claimed.delete(issue.id);
          return;
        }
        this.state.claimed.add(issue.id);
        this.spawnWorker(issue, attempt);
        this.notifyListeners();
      }
    }, delayMs);

    const entry: RetryEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt,
      due_at_ms: Date.now() + delayMs,
      timer_handle: timerHandle,
      error: null,
    };

    this.state.retry_attempts.set(issue.id, entry);
  }

  /** Trigger an immediate poll tick (used by HTTP server /api/v1/refresh). */
  triggerPoll(): void {
    if (this.stopping) return;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.schedulePoll(0);
  }
}
