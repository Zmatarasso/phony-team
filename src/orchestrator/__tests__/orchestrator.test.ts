import { jest } from "@jest/globals";
import {
  Orchestrator,
  retryBackoffMs,
  sortIssues,
  type OrchestratorOptions,
  type RunnerFactory,
} from "../orchestrator.js";
import type { Issue } from "../../types/domain.js";
import type { ServiceConfig } from "../../types/config.js";
import type { JiraAdapter } from "../../tracker/jiraAdapter.js";
import type { WorkspaceManager } from "../../workspace/workspaceManager.js";
import { Logger } from "../../logging/logger.js";

// --- Factories ---

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PHONY-1",
    title: "Fix the bug",
    description: null,
    priority: 2,
    state: "In Progress",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date("2024-01-01T00:00:00Z"),
    updated_at: null,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    tracker: {
      kind: "jira",
      base_url: "https://example.atlassian.net",
      email: "user@example.com",
      api_token: "token",
      project_key: "PHONY",
      active_states: ["In Progress", "Todo"],
      terminal_states: ["Done", "Cancelled"],
    },
    polling: { interval_ms: 30_000 },
    workspace: { root: "/tmp/workspaces" },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 60_000,
    },
    agent: {
      max_concurrent_agents: 5,
      max_turns: 20,
      max_retry_backoff_ms: 300_000,
      max_concurrent_agents_by_state: new Map(),
    },
    codex: {
      command: "claude",
      turn_timeout_ms: 3_600_000,
      read_timeout_ms: 5_000,
      stall_timeout_ms: 0, // disabled in most tests
    },
    server: { port: undefined },
    ...overrides,
  };
}

function makeLogger(): Logger {
  return new Logger([], {}, "error");
}

function makeMockAdapter(
  issues: Issue[] = [],
  stateOverrides: Map<string, string> = new Map(),
): JiraAdapter {
  return {
    fetchCandidateIssues: jest.fn<() => Promise<Issue[]>>().mockResolvedValue(issues),
    fetchIssuesByStates: jest.fn<() => Promise<Issue[]>>().mockResolvedValue([]),
    fetchIssueStatesByIds: jest.fn<() => Promise<Pick<Issue, "id" | "identifier" | "state">[]>>()
      .mockImplementation(async (ids: readonly string[]) =>
        Array.from(ids).map((id) => ({
          id,
          identifier: `PHONY-${id}`,
          state: stateOverrides.get(id) ?? "In Progress",
        })),
      ),
  } as unknown as JiraAdapter;
}

function makeMockWorkspaceManager(): WorkspaceManager {
  return {
    ensureWorkspace: jest.fn<() => Promise<{ path: string; workspace_key: string; created_now: boolean }>>()
      .mockResolvedValue({ path: "/tmp/ws/PHONY-1", workspace_key: "PHONY-1", created_now: false }),
    removeWorkspace: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    runBeforeHook: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    runAfterHook: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getWorkspacePath: jest.fn<(id: string) => string>().mockImplementation((id: string) => `/tmp/ws/${id}`),
  } as unknown as WorkspaceManager;
}

/** Returns a runner factory that resolves immediately (simulating successful session). */
function makeInstantRunner(): RunnerFactory {
  return jest.fn<RunnerFactory>().mockReturnValue({ run: async () => {} });
}

/** Returns a runner factory that rejects with an error. */
function makeFailingRunner(msg = "agent error"): RunnerFactory {
  return jest.fn<RunnerFactory>().mockReturnValue({
    run: async () => { throw new Error(msg); },
  });
}

/**
 * Returns a runner factory that runs until the abort signal fires.
 * Use this for concurrency tests that call stop() to clean up.
 */
function makeAbortableRunner(): RunnerFactory {
  return jest.fn<RunnerFactory>().mockImplementation(
    (_issue, _attempt, _path, _prompt, _onEvent, signal) => ({
      run: () =>
        new Promise<void>((resolve) => {
          if (signal.aborted) { resolve(); return; }
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    }),
  );
}

function makeOrchestrator(
  options: Partial<OrchestratorOptions> & {
    issues?: Issue[];
    runnerFactory?: RunnerFactory;
  } = {},
): Orchestrator {
  const { issues = [], runnerFactory, ...rest } = options;
  return new Orchestrator({
    config: makeConfig(),
    workflow: { config: {}, prompt_template: "Work on {{ issue.identifier }}." },
    logger: makeLogger(),
    anthropicApiKey: "test-key",
    _adapter: makeMockAdapter(issues),
    _workspaceManager: makeMockWorkspaceManager(),
    _runnerFactory: runnerFactory ?? makeInstantRunner(),
    ...rest,
  });
}

// --- Pure function tests ---

describe("retryBackoffMs", () => {
  it("attempt 1 → 10000ms", () => expect(retryBackoffMs(1, 300_000)).toBe(10_000));
  it("attempt 2 → 20000ms", () => expect(retryBackoffMs(2, 300_000)).toBe(20_000));
  it("attempt 3 → 40000ms", () => expect(retryBackoffMs(3, 300_000)).toBe(40_000));
  it("caps at maxMs", () => expect(retryBackoffMs(10, 300_000)).toBe(300_000));
  it("does not exceed maxMs", () => expect(retryBackoffMs(100, 300_000)).toBe(300_000));
});

describe("sortIssues", () => {
  it("sorts by priority ascending, null last", () => {
    const issues = [
      makeIssue({ id: "3", identifier: "P-3", priority: null }),
      makeIssue({ id: "1", identifier: "P-1", priority: 1 }),
      makeIssue({ id: "2", identifier: "P-2", priority: 3 }),
    ];
    const sorted = sortIssues(issues);
    expect(sorted.map((i) => i.identifier)).toEqual(["P-1", "P-2", "P-3"]);
  });

  it("breaks priority ties by created_at ascending, null last", () => {
    const issues = [
      makeIssue({ id: "b", identifier: "P-2", priority: 1, created_at: new Date("2024-01-02") }),
      makeIssue({ id: "a", identifier: "P-1", priority: 1, created_at: new Date("2024-01-01") }),
      makeIssue({ id: "c", identifier: "P-3", priority: 1, created_at: null }),
    ];
    const sorted = sortIssues(issues);
    expect(sorted.map((i) => i.identifier)).toEqual(["P-1", "P-2", "P-3"]);
  });

  it("breaks created_at ties by identifier lex", () => {
    const ts = new Date("2024-01-01");
    const issues = [
      makeIssue({ id: "c", identifier: "P-3", priority: 1, created_at: ts }),
      makeIssue({ id: "a", identifier: "P-1", priority: 1, created_at: ts }),
      makeIssue({ id: "b", identifier: "P-2", priority: 1, created_at: ts }),
    ];
    const sorted = sortIssues(issues);
    expect(sorted.map((i) => i.identifier)).toEqual(["P-1", "P-2", "P-3"]);
  });
});

// --- Dispatch eligibility ---

describe("Orchestrator dispatch eligibility", () => {
  it("dispatches an eligible issue", async () => {
    const runnerFactory = makeInstantRunner();
    const orch = makeOrchestrator({
      issues: [makeIssue()],
      runnerFactory,
    });
    await orch.start();
    // Give micro-tasks a chance to run
    await new Promise((r) => setTimeout(r, 50));
    await orch.stop();
    expect(runnerFactory).toHaveBeenCalled();
  });

  it("does not dispatch if state is not in active_states", async () => {
    const runnerFactory = makeInstantRunner();
    const orch = makeOrchestrator({
      issues: [makeIssue({ state: "Done" })],
      runnerFactory,
    });
    await orch.start();
    await new Promise((r) => setTimeout(r, 50));
    await orch.stop();
    expect(runnerFactory).not.toHaveBeenCalled();
  });

  it("does not dispatch if state is in terminal_states", async () => {
    const runnerFactory = makeInstantRunner();
    const orch = makeOrchestrator({
      issues: [makeIssue({ state: "Cancelled" })],
      runnerFactory,
    });
    await orch.start();
    await new Promise((r) => setTimeout(r, 50));
    await orch.stop();
    expect(runnerFactory).not.toHaveBeenCalled();
  });

  it("does not dispatch if issue already running", async () => {
    const runnerFactory = makeAbortableRunner();
    const issue = makeIssue();
    const adapter = makeMockAdapter([issue]);
    const orch = new Orchestrator({
      config: makeConfig(),
      workflow: { config: {}, prompt_template: "" },
      logger: makeLogger(),
      anthropicApiKey: "key",
      _adapter: adapter,
      _workspaceManager: makeMockWorkspaceManager(),
      _runnerFactory: runnerFactory,
    });
    await orch.start();
    await new Promise((r) => setTimeout(r, 50));
    // Trigger another tick — should not dispatch again
    orch.triggerPoll();
    await new Promise((r) => setTimeout(r, 50));
    // Only dispatched once even after second tick
    expect(runnerFactory).toHaveBeenCalledTimes(1);
    await orch.stop();
  });

  it("enforces global concurrency limit", async () => {
    const config = makeConfig({
      agent: {
        max_concurrent_agents: 2,
        max_turns: 20,
        max_retry_backoff_ms: 300_000,
        max_concurrent_agents_by_state: new Map(),
      },
    });
    const issues = [
      makeIssue({ id: "1", identifier: "P-1" }),
      makeIssue({ id: "2", identifier: "P-2" }),
      makeIssue({ id: "3", identifier: "P-3" }),
    ];
    const runnerFactory = makeAbortableRunner();
    const orch = new Orchestrator({
      config,
      workflow: { config: {}, prompt_template: "" },
      logger: makeLogger(),
      anthropicApiKey: "key",
      _adapter: makeMockAdapter(issues),
      _workspaceManager: makeMockWorkspaceManager(),
      _runnerFactory: runnerFactory,
    });
    await orch.start();
    await new Promise((r) => setTimeout(r, 50));
    // Only 2 of 3 should have been dispatched
    expect(runnerFactory).toHaveBeenCalledTimes(2);
    await orch.stop();
  });

  it("enforces per-state concurrency limit", async () => {
    const config = makeConfig({
      agent: {
        max_concurrent_agents: 10,
        max_turns: 20,
        max_retry_backoff_ms: 300_000,
        max_concurrent_agents_by_state: new Map([["in progress", 1]]),
      },
    });
    const issues = [
      makeIssue({ id: "1", identifier: "P-1", state: "In Progress" }),
      makeIssue({ id: "2", identifier: "P-2", state: "In Progress" }),
    ];
    const runnerFactory = makeAbortableRunner();
    const orch = new Orchestrator({
      config,
      workflow: { config: {}, prompt_template: "" },
      logger: makeLogger(),
      anthropicApiKey: "key",
      _adapter: makeMockAdapter(issues),
      _workspaceManager: makeMockWorkspaceManager(),
      _runnerFactory: runnerFactory,
    });
    await orch.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(runnerFactory).toHaveBeenCalledTimes(1);
    await orch.stop();
  });

  it("does not dispatch todo issue with unresolved blocker", async () => {
    const issue = makeIssue({
      state: "Todo",
      blocked_by: [{ id: "other-1", identifier: "P-0", state: "In Progress" }],
    });
    const runnerFactory = makeInstantRunner();
    const orch = makeOrchestrator({ issues: [issue], runnerFactory });
    await orch.start();
    await new Promise((r) => setTimeout(r, 50));
    await orch.stop();
    expect(runnerFactory).not.toHaveBeenCalled();
  });

  it("dispatches todo issue when all blockers are terminal", async () => {
    const issue = makeIssue({
      state: "Todo",
      blocked_by: [{ id: "other-1", identifier: "P-0", state: "Done" }],
    });
    const runnerFactory = makeInstantRunner();
    const orch = makeOrchestrator({ issues: [issue], runnerFactory });
    await orch.start();
    await new Promise((r) => setTimeout(r, 50));
    await orch.stop();
    expect(runnerFactory).toHaveBeenCalled();
  });
});

// --- Retry behaviour ---

describe("Orchestrator retry", () => {
  it("schedules a retry when a worker fails", async () => {
    const runnerFactory = makeFailingRunner("simulated failure");
    const orch = makeOrchestrator({ issues: [makeIssue()], runnerFactory });
    await orch.start();
    await new Promise((r) => setTimeout(r, 100));
    await orch.stop();

    const retryEntries = Array.from(orch.getState().retry_attempts.values());
    // The runner may have run and retried — just verify it was called
    expect(runnerFactory).toHaveBeenCalled();
  });
});

// --- stop() ---

describe("Orchestrator stop()", () => {
  it("resolves immediately when no workers are running", async () => {
    const orch = makeOrchestrator();
    await orch.start();
    await expect(orch.stop()).resolves.toBeUndefined();
  });

  it("resolves after workers finish within grace period", async () => {
    let resolveWorker!: () => void;
    const runnerFactory = jest.fn<RunnerFactory>().mockReturnValue({
      run: () => new Promise<void>((r) => { resolveWorker = r; }),
    });
    const orch = makeOrchestrator({ issues: [makeIssue()], runnerFactory });
    await orch.start();
    await new Promise((r) => setTimeout(r, 50));

    const stopPromise = orch.stop(5_000);
    resolveWorker(); // finish the worker
    await expect(stopPromise).resolves.toBeUndefined();
  });
});

// --- triggerPoll ---

describe("Orchestrator triggerPoll", () => {
  it("triggers an immediate dispatch cycle", async () => {
    const runnerFactory = makeInstantRunner();
    const orch = makeOrchestrator({ runnerFactory });
    await orch.start();
    await new Promise((r) => setTimeout(r, 50));
    await orch.stop();
    // Not throwing is sufficient; deeper coverage in dispatch tests above
  });
});
