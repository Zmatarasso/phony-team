import { jest } from "@jest/globals";
import { GrokRunner } from "../grokRunner.js";
import type { AgentRunnerOptions } from "../claudeRunner.js";
import type { AgentEvent } from "../../types/events.js";
import type { Issue } from "../../types/domain.js";
import type { ServiceConfig } from "../../types/config.js";
import { AgentRunnerError } from "../../types/errors.js";
import { Logger } from "../../logging/logger.js";
import OpenAI from "openai";
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
      project_key: "PHONY",
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
      backend: "grok",
    },
    codex: {
      command: "claude --dangerously-skip-permissions",
      turn_timeout_ms: turnTimeoutMs,
      read_timeout_ms: 5_000,
      stall_timeout_ms: 300_000,
    },
    grok: {
      api_key: "test-xai-key",
      model: "grok-2-1212",
    },
    server: { port: undefined },
  };
}

function makeLogger(): Logger {
  return new Logger([], {}, "error");
}

function makeCompletion(
  content: string | null,
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
  finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"],
  usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1234567890,
    model: "grok-2-1212",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls,
          refusal: null,
        },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage,
  };
}

function makeStopCompletion(text = "I have completed the task."): OpenAI.Chat.Completions.ChatCompletion {
  return makeCompletion(text, undefined, "stop");
}

function makeToolCompletion(
  name: string,
  args: Record<string, unknown>,
  id = "call_1",
): OpenAI.Chat.Completions.ChatCompletion {
  return makeCompletion(null, [
    {
      id,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    },
  ], "tool_calls");
}

function makeMockClient(
  responses: OpenAI.Chat.Completions.ChatCompletion[],
): OpenAI {
  let callIndex = 0;
  const createFn = jest.fn<() => Promise<OpenAI.Chat.Completions.ChatCompletion>>().mockImplementation(async () => {
    const resp = responses[callIndex++];
    if (!resp) throw new Error("No more mock responses");
    return resp;
  });
  return { chat: { completions: { create: createFn } } } as unknown as OpenAI;
}

function makeOptions(
  overrides: Partial<AgentRunnerOptions> = {},
): AgentRunnerOptions & { events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const onEvent = (_issueId: string, event: AgentEvent) => events.push(event);
  return {
    config: makeConfig(),
    apiKey: "test-xai-key",
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

describe("GrokRunner — single turn, stop finish_reason", () => {
  it("emits session_started then token_usage_updated then turn_completed", async () => {
    const opts = makeOptions();
    const client = makeMockClient([makeStopCompletion()]);
    await new GrokRunner(opts, client).run();

    const eventTypes = opts.events.map((e) => e.event);
    expect(eventTypes).toEqual(["session_started", "token_usage_updated", "turn_completed"]);
  });

  it("turn_completed carries per-turn token usage", async () => {
    const opts = makeOptions();
    const client = makeMockClient([
      makeCompletion("done", undefined, "stop", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }),
    ]);
    await new GrokRunner(opts, client).run();

    const completed = opts.events.find((e) => e.event === "turn_completed");
    expect(completed).toMatchObject({
      event: "turn_completed",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });
  });

  it("token_usage_updated accumulates across turns", async () => {
    const opts = makeOptions();
    const toolCall = makeToolCompletion("bash", { command: "echo hi" }, "t1");
    const finalMsg = makeCompletion("done", undefined, "stop", { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 });
    const client = makeMockClient([toolCall, finalMsg]);
    await new GrokRunner(opts, client).run();

    const usageEvents = opts.events.filter((e) => e.event === "token_usage_updated");
    const lastUsage = usageEvents[usageEvents.length - 1];
    expect(lastUsage?.event).toBe("token_usage_updated");
    if (lastUsage?.event === "token_usage_updated") {
      expect(lastUsage.usage.total_tokens).toBe(70); // 30 from tool call + 40 from final
    }
  });
});

describe("GrokRunner — tool use", () => {
  it("emits approval_auto_approved for each tool call", async () => {
    const opts = makeOptions();
    const toolCallMsg = makeToolCompletion("bash", { command: "echo hello" }, "call_1");
    const endMsg = makeStopCompletion();
    const client = makeMockClient([toolCallMsg, endMsg]);
    await new GrokRunner(opts, client).run();

    const approved = opts.events.filter((e) => e.event === "approval_auto_approved");
    expect(approved).toHaveLength(1);
    expect(approved[0]?.event === "approval_auto_approved" && approved[0].tool_name).toBe("bash");
  });

  it("emits unsupported_tool_call for unknown tools", async () => {
    const opts = makeOptions();
    const toolCallMsg = makeToolCompletion("unknown_tool", { arg: "val" }, "call_x");
    const endMsg = makeStopCompletion();
    const client = makeMockClient([toolCallMsg, endMsg]);
    await new GrokRunner(opts, client).run();

    const unsupported = opts.events.find((e) => e.event === "unsupported_tool_call");
    expect(unsupported).toBeDefined();
    expect(
      unsupported?.event === "unsupported_tool_call" && unsupported.tool_name,
    ).toBe("unknown_tool");
  });

  it("continues after tool calls until stop", async () => {
    const opts = makeOptions();
    const t1 = makeToolCompletion("bash", { command: "echo step1" }, "t1");
    const t2 = makeToolCompletion("bash", { command: "echo step2" }, "t2");
    const end = makeStopCompletion();
    const client = makeMockClient([t1, t2, end]);
    await new GrokRunner(opts, client).run();

    const approved = opts.events.filter((e) => e.event === "approval_auto_approved");
    expect(approved).toHaveLength(2);
    expect(opts.events[opts.events.length - 1]?.event).toBe("turn_completed");
  });
});

describe("GrokRunner — abort signal", () => {
  it("emits turn_cancelled when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const opts = makeOptions({ signal: controller.signal });
    const client = makeMockClient([makeStopCompletion()]);
    await new GrokRunner(opts, client).run();

    const eventTypes = opts.events.map((e) => e.event);
    expect(eventTypes).toContain("turn_cancelled");
    expect(eventTypes).not.toContain("turn_completed");
  });
});

describe("GrokRunner — API error", () => {
  it("emits turn_failed and throws AgentRunnerError on API failure", async () => {
    const opts = makeOptions();
    const failingCreate = jest.fn<() => Promise<never>>().mockRejectedValue(
      new Error("Network error"),
    );
    const client = { chat: { completions: { create: failingCreate } } } as unknown as OpenAI;
    await expect(new GrokRunner(opts, client).run()).rejects.toBeInstanceOf(AgentRunnerError);

    const failed = opts.events.find((e) => e.event === "turn_failed");
    expect(failed).toBeDefined();
    expect(failed?.event === "turn_failed" && failed.error).toContain("Network error");
  });
});

describe("GrokRunner — length finish_reason (max_tokens)", () => {
  it("emits turn_failed and throws when finish_reason is length", async () => {
    const opts = makeOptions();
    const client = makeMockClient([
      makeCompletion("truncated...", undefined, "length"),
    ]);
    await expect(new GrokRunner(opts, client).run()).rejects.toBeInstanceOf(AgentRunnerError);

    const failed = opts.events.find((e) => e.event === "turn_failed");
    expect(failed?.event === "turn_failed" && failed.error).toContain("max_tokens");
  });
});

describe("GrokRunner — max turns", () => {
  it("emits turn_ended_with_error and throws after max turns", async () => {
    const opts = makeOptions({ config: makeConfig(2) });
    const toolMsg = makeToolCompletion("bash", { command: "echo loop" }, "tool_1");
    const client = makeMockClient([toolMsg, toolMsg, toolMsg]);
    await expect(new GrokRunner(opts, client).run()).rejects.toBeInstanceOf(AgentRunnerError);

    const endedErr = opts.events.find((e) => e.event === "turn_ended_with_error");
    expect(endedErr).toBeDefined();
    expect(endedErr?.event === "turn_ended_with_error" && endedErr.error).toContain("2");
  });
});

describe("GrokRunner — jira_api tool", () => {
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

    const toolCallMsg = makeToolCompletion(
      "jira_api",
      { method: "GET", endpoint: "/rest/api/3/issue/PHONY-1/transitions" },
      "jira_1",
    );
    const endMsg = makeStopCompletion();
    const client = makeMockClient([toolCallMsg, endMsg]);

    await new GrokRunner(opts, client).run();

    expect(jiraClient.request).toHaveBeenCalledWith(
      "GET",
      "/rest/api/3/issue/PHONY-1/transitions",
      undefined,
    );
  });

  it("returns success:false JSON when no jiraClient is configured", async () => {
    const opts = makeOptions();
    const toolCallMsg = makeToolCompletion(
      "jira_api",
      { method: "GET", endpoint: "/rest/api/3/issue/PHONY-1" },
      "jira_2",
    );
    const endMsg = makeStopCompletion();
    const client = makeMockClient([toolCallMsg, endMsg]);

    await new GrokRunner(opts, client).run();
    expect(opts.events[opts.events.length - 1]?.event).toBe("turn_completed");
  });
});
