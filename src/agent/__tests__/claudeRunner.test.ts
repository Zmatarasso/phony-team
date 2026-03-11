import { jest } from "@jest/globals";
import { AgentRunner } from "../claudeRunner.js";
import type { AgentRunnerOptions } from "../claudeRunner.js";
import type { AgentEvent } from "../../types/events.js";
import type { Issue } from "../../types/domain.js";
import type { ServiceConfig } from "../../types/config.js";
import { AgentRunnerError } from "../../types/errors.js";
import { Logger } from "../../logging/logger.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { JiraClient } from "../../tracker/jiraClient.js";

// --- Factories ---

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PHONY-1",
    title: "Fix the bug",
    description: "Something is broken",
    priority: 2,
    state: "In Progress",
    branch_name: "PHONY-1",
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function makeConfig(maxTurns = 20, turnTimeoutMs = 60_000): ServiceConfig {
  return {
    tracker: {
      kind: "jira",
      base_url: "https://example.atlassian.net",
      email: "user@example.com",
      api_token: "token",
      space_key: "PHONY",
      active_states: ["In Progress"],
      terminal_states: ["Done"],
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
      max_turns: maxTurns,
      max_retry_backoff_ms: 300_000,
      max_concurrent_agents_by_state: new Map(),
    },
    codex: {
      command: "claude --dangerously-skip-permissions",
      turn_timeout_ms: turnTimeoutMs,
      read_timeout_ms: 5_000,
      stall_timeout_ms: 300_000,
    },
    server: { port: undefined },
  };
}

function makeLogger(): Logger {
  return new Logger([], {}, "error");
}

function makeMessage(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.Message["stop_reason"] = "end_turn",
  usage: { input_tokens: number; output_tokens: number } = { input_tokens: 10, output_tokens: 20 },
): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content,
    model: "claude-sonnet-4-6",
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

function makeTextMessage(text = "I have completed the task."): Anthropic.Message {
  return makeMessage([{ type: "text", text }]);
}

function makeToolUseMessage(
  toolName: string,
  input: Record<string, unknown>,
  id = "tool_1",
): Anthropic.Message {
  return makeMessage(
    [
      {
        type: "tool_use",
        id,
        name: toolName,
        input,
      },
    ],
    "tool_use",
  );
}

// Build a mock Anthropic client with a controllable messages.create
function makeMockClient(
  responses: Anthropic.Message[],
): Anthropic {
  let callIndex = 0;
  const createFn = jest.fn<() => Promise<Anthropic.Message>>().mockImplementation(async () => {
    const resp = responses[callIndex++];
    if (!resp) throw new Error("No more mock responses");
    return resp;
  });
  return { messages: { create: createFn } } as unknown as Anthropic;
}

function makeOptions(
  overrides: Partial<AgentRunnerOptions> = {},
): AgentRunnerOptions & { events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const onEvent = (_issueId: string, event: AgentEvent) => events.push(event);
  return {
    config: makeConfig(),
    apiKey: "test-key",
    workspacePath: "/tmp/test-workspace",
    issue: makeIssue(),
    systemPrompt: "You are a coding agent.",
    attempt: null,
    onEvent,
    logger: makeLogger(),
    events,
    ...overrides,
  };
}

// --- Tests ---

describe("AgentRunner — single turn, end_turn", () => {
  it("emits session_started then token_usage_updated then turn_completed", async () => {
    const opts = makeOptions();
    const client = makeMockClient([makeTextMessage()]);
    await new AgentRunner(opts, client).run();

    const eventTypes = opts.events.map((e) => e.event);
    expect(eventTypes).toEqual(["session_started", "token_usage_updated", "agent_activity", "turn_completed"]);
  });

  it("turn_completed carries per-turn token usage", async () => {
    const opts = makeOptions();
    const client = makeMockClient([makeMessage([{ type: "text", text: "done" }], "end_turn", { input_tokens: 100, output_tokens: 50 })]);
    await new AgentRunner(opts, client).run();

    const completed = opts.events.find((e) => e.event === "turn_completed");
    expect(completed).toMatchObject({
      event: "turn_completed",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });
  });

  it("token_usage_updated accumulates across turns", async () => {
    const opts = makeOptions();
    // Turn 1: tool call, Turn 2: end_turn
    const toolCall = makeToolUseMessage("bash", { command: "echo hi" }, "tool_1");
    const finalMsg = makeMessage([{ type: "text", text: "done" }], "end_turn", { input_tokens: 30, output_tokens: 10 });
    const client = makeMockClient([toolCall, finalMsg]);
    await new AgentRunner(opts, client).run();

    const usageEvents = opts.events.filter((e) => e.event === "token_usage_updated");
    // Last usage event should have cumulative totals
    const lastUsage = usageEvents[usageEvents.length - 1];
    expect(lastUsage?.event).toBe("token_usage_updated");
    if (lastUsage?.event === "token_usage_updated") {
      expect(lastUsage.usage.total_tokens).toBe(70); // 20+10 from tool call + 30+10 from final
    }
  });
});

describe("AgentRunner — tool use", () => {
  it("emits approval_auto_approved for each tool call", async () => {
    const opts = makeOptions();
    const toolCallMsg = makeToolUseMessage("bash", { command: "echo hello" }, "tool_1");
    const endMsg = makeTextMessage();
    const client = makeMockClient([toolCallMsg, endMsg]);
    await new AgentRunner(opts, client).run();

    const approved = opts.events.filter((e) => e.event === "approval_auto_approved");
    expect(approved).toHaveLength(1);
    expect(approved[0]?.event === "approval_auto_approved" && approved[0].tool_name).toBe("bash");
  });

  it("emits unsupported_tool_call for unknown tools", async () => {
    const opts = makeOptions();
    const toolCallMsg = makeToolUseMessage("unknown_tool", { arg: "val" }, "tool_x");
    const endMsg = makeTextMessage();
    const client = makeMockClient([toolCallMsg, endMsg]);
    await new AgentRunner(opts, client).run();

    const unsupported = opts.events.find((e) => e.event === "unsupported_tool_call");
    expect(unsupported).toBeDefined();
    expect(
      unsupported?.event === "unsupported_tool_call" && unsupported.tool_name,
    ).toBe("unknown_tool");
  });

  it("continues after tool calls until end_turn", async () => {
    const opts = makeOptions();
    const t1 = makeToolUseMessage("bash", { command: "echo step1" }, "t1");
    const t2 = makeToolUseMessage("bash", { command: "echo step2" }, "t2");
    const end = makeTextMessage();
    const client = makeMockClient([t1, t2, end]);
    await new AgentRunner(opts, client).run();

    const approved = opts.events.filter((e) => e.event === "approval_auto_approved");
    expect(approved).toHaveLength(2);
    expect(opts.events[opts.events.length - 1]?.event).toBe("turn_completed");
  });
});

describe("AgentRunner — abort signal", () => {
  it("emits turn_cancelled when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const opts = makeOptions({ signal: controller.signal });
    const client = makeMockClient([makeTextMessage()]);
    await new AgentRunner(opts, client).run();

    const eventTypes = opts.events.map((e) => e.event);
    expect(eventTypes).toContain("turn_cancelled");
    expect(eventTypes).not.toContain("turn_completed");
  });
});

describe("AgentRunner — API error", () => {
  it("emits turn_failed and throws AgentRunnerError on API failure", async () => {
    const opts = makeOptions();
    const failingCreate = jest.fn<() => Promise<never>>().mockRejectedValue(
      new Error("Network error"),
    );
    const client = { messages: { create: failingCreate } } as unknown as Anthropic;
    await expect(new AgentRunner(opts, client).run()).rejects.toBeInstanceOf(AgentRunnerError);

    const failed = opts.events.find((e) => e.event === "turn_failed");
    expect(failed).toBeDefined();
    expect(failed?.event === "turn_failed" && failed.error).toContain("Network error");
  });
});

describe("AgentRunner — max_tokens stop", () => {
  it("emits turn_failed and throws when stop_reason is max_tokens", async () => {
    const opts = makeOptions();
    const maxTokensMsg = makeMessage(
      [{ type: "text", text: "truncated..." }],
      "max_tokens",
    );
    const client = makeMockClient([maxTokensMsg]);
    await expect(new AgentRunner(opts, client).run()).rejects.toBeInstanceOf(AgentRunnerError);

    const failed = opts.events.find((e) => e.event === "turn_failed");
    expect(failed?.event === "turn_failed" && failed.error).toContain("max_tokens");
  });
});

describe("AgentRunner — max turns", () => {
  it("emits turn_ended_with_error and throws after max turns", async () => {
    const opts = makeOptions({ config: makeConfig(2) });
    // Always return a tool call so it never ends naturally
    const toolMsg = makeToolUseMessage("bash", { command: "echo loop" }, "tool_1");
    const client = makeMockClient([toolMsg, toolMsg, toolMsg]);
    await expect(new AgentRunner(opts, client).run()).rejects.toBeInstanceOf(AgentRunnerError);

    const endedErr = opts.events.find((e) => e.event === "turn_ended_with_error");
    expect(endedErr).toBeDefined();
    expect(endedErr?.event === "turn_ended_with_error" && endedErr.error).toContain("2");
  });
});

describe("AgentRunner — jira_api tool", () => {
  function makeMockJiraClient(
    impl: (m: string, e: string, b?: Record<string, unknown>) => Promise<unknown>,
  ): JiraClient {
    return {
      request: jest.fn<typeof impl>().mockImplementation(impl),
    } as unknown as JiraClient;
  }

  it("dispatches jira_api tool calls to the JiraClient", async () => {
    const jiraClient = makeMockJiraClient(async () => ({ transitions: [] }));
    const opts = makeOptions({ jiraClient });

    const toolCallMsg = makeToolUseMessage(
      "jira_api",
      { method: "GET", endpoint: "/rest/api/3/issue/PHONY-1/transitions" },
      "jira_1",
    );
    const endMsg = makeTextMessage();
    const client = makeMockClient([toolCallMsg, endMsg]);

    await new AgentRunner(opts, client).run();

    expect(jiraClient.request).toHaveBeenCalledWith(
      "GET",
      "/rest/api/3/issue/PHONY-1/transitions",
      undefined,
    );
  });

  it("returns success:false JSON when no jiraClient is configured", async () => {
    // No jiraClient in options — should return error JSON, not crash
    const opts = makeOptions();
    const toolCallMsg = makeToolUseMessage(
      "jira_api",
      { method: "GET", endpoint: "/rest/api/3/issue/PHONY-1" },
      "jira_2",
    );
    const endMsg = makeTextMessage();
    const client = makeMockClient([toolCallMsg, endMsg]);

    // Should complete (not throw) — the error is returned as a tool result
    await new AgentRunner(opts, client).run();
    expect(opts.events[opts.events.length - 1]?.event).toBe("turn_completed");
  });
});
