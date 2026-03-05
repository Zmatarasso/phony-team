import OpenAI from "openai";
import { randomUUID } from "crypto";
import type { ServiceConfig } from "../types/config.js";
import type { Issue } from "../types/domain.js";
import type { AgentEventCallback, TokenUsage } from "../types/events.js";
import type { Logger } from "../logging/logger.js";
import type { JiraClient } from "../tracker/jiraClient.js";
import { AgentRunnerError } from "../types/errors.js";
import { executeBash } from "./tools/bashExecute.js";
import { readWorkspaceFile, writeWorkspaceFile, listWorkspaceDir } from "./tools/fileOps.js";
import { executeJiraTool } from "./tools/jiraTool.js";
import type { AgentRunnerOptions } from "./claudeRunner.js";

// Re-export so orchestrator can use a single options type
export type { AgentRunnerOptions };

const BASE_TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Execute a shell command in the workspace directory. The command runs with the workspace root as cwd.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Path may be relative to workspace root or absolute.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to workspace root, or absolute path within workspace",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write text content to a file. Creates the file if it does not exist; overwrites if it does.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to workspace root, or absolute path within workspace",
          },
          content: { type: "string", description: "Text content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and subdirectories at a given path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to workspace root, or absolute within workspace",
          },
        },
        required: ["path"],
      },
    },
  },
];

const JIRA_TOOL_DEFINITION_OPENAI: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "jira_api",
    description:
      "Call the Jira REST API v3. Use this to transition issue states, add comments, look up " +
      "related issues, or post PR links. The API is pre-authenticated — never include credentials.",
    parameters: {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT"],
          description: "HTTP method",
        },
        endpoint: {
          type: "string",
          description: "Jira REST API v3 path, e.g. /rest/api/3/issue/PHONY-42/transitions",
        },
        body: {
          type: "object",
          description: "Request body for POST/PUT requests",
          additionalProperties: true,
        },
      },
      required: ["method", "endpoint"],
    },
  },
};

export class GrokRunner {
  private readonly client: OpenAI;
  private readonly tools: OpenAI.Chat.Completions.ChatCompletionTool[];

  constructor(
    private readonly options: AgentRunnerOptions,
    client?: OpenAI,
  ) {
    this.client = client ?? new OpenAI({
      apiKey: options.config.grok.api_key,
      baseURL: "https://api.x.ai/v1",
    });
    this.tools = options.jiraClient
      ? [...BASE_TOOL_DEFINITIONS, JIRA_TOOL_DEFINITION_OPENAI]
      : BASE_TOOL_DEFINITIONS;
  }

  async run(): Promise<void> {
    const { issue, systemPrompt, workspacePath, onEvent, logger, config } = this.options;
    const threadId = randomUUID();
    let turnId = randomUUID();

    onEvent(issue.id, {
      event: "session_started",
      timestamp: new Date(),
      codex_app_server_pid: null,
      thread_id: threadId,
      turn_id: turnId,
    });

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Please work on the issue described in the system prompt." },
    ];

    const maxTurns = config.agent.max_turns;
    const turnTimeoutMs = config.codex.turn_timeout_ms;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber++) {
      if (this.options.signal?.aborted) {
        onEvent(issue.id, {
          event: "turn_cancelled",
          timestamp: new Date(),
          codex_app_server_pid: null,
          turn_id: turnId,
        });
        return;
      }

      turnId = randomUUID();

      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        response = await this.callApi(messages, turnTimeoutMs);
      } catch (err) {
        if (this.options.signal?.aborted) {
          onEvent(issue.id, {
            event: "turn_cancelled",
            timestamp: new Date(),
            codex_app_server_pid: null,
            turn_id: turnId,
          });
          return;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        onEvent(issue.id, {
          event: "turn_failed",
          timestamp: new Date(),
          codex_app_server_pid: null,
          turn_id: turnId,
          error: errMsg,
        });
        throw new AgentRunnerError(
          "turn_failed",
          `API call failed on turn ${turnNumber}: ${errMsg}`,
          err,
        );
      }

      const choice = response.choices[0];
      if (!choice) {
        throw new AgentRunnerError("turn_failed", "No choices returned from API");
      }

      // Accumulate and report token usage
      const inputTokens = response.usage?.prompt_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? 0;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      onEvent(issue.id, {
        event: "token_usage_updated",
        timestamp: new Date(),
        codex_app_server_pid: null,
        usage: {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          total_tokens: totalInputTokens + totalOutputTokens,
        },
      });

      const assistantMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
        role: "assistant",
        content: choice.message.content ?? null,
        ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
      };
      messages.push(assistantMsg);

      if (choice.finish_reason === "length") {
        const errMsg = "Model reached max_tokens limit";
        onEvent(issue.id, {
          event: "turn_failed",
          timestamp: new Date(),
          codex_app_server_pid: null,
          turn_id: turnId,
          error: errMsg,
        });
        throw new AgentRunnerError("turn_failed", errMsg);
      }

      const toolCalls = (choice.message.tool_calls ?? []).filter(
        (tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & { type: "function" } =>
          tc.type === "function",
      );

      if (choice.finish_reason === "stop" || toolCalls.length === 0) {
        const turnUsage: TokenUsage = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        };
        onEvent(issue.id, {
          event: "turn_completed",
          timestamp: new Date(),
          codex_app_server_pid: null,
          turn_id: turnId,
          usage: turnUsage,
        });
        return;
      }

      // Execute each tool call and collect results
      for (const toolCall of toolCalls) {
        const name = toolCall.function.name;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        } catch {
          // leave input empty
        }

        onEvent(issue.id, {
          event: "approval_auto_approved",
          timestamp: new Date(),
          codex_app_server_pid: null,
          tool_name: name,
        });

        const resultContent = await this.dispatchTool(name, input);
        logger.debug(`Tool ${name} completed`, { issue_id: issue.id });

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: resultContent,
        });
      }
    }

    const errMsg = `Reached maximum turn limit (${maxTurns})`;
    onEvent(issue.id, {
      event: "turn_ended_with_error",
      timestamp: new Date(),
      codex_app_server_pid: null,
      turn_id: turnId,
      error: errMsg,
    });
    throw new AgentRunnerError("turn_failed", errMsg);
  }

  private async callApi(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    timeoutMs: number,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const controller = new AbortController();
    const outerSignal = this.options.signal;
    if (outerSignal?.aborted) {
      controller.abort();
    } else {
      outerSignal?.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.client.chat.completions.create(
        {
          model: this.options.config.grok.model,
          max_tokens: 8096,
          messages,
          tools: this.tools,
          tool_choice: "auto",
        },
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async dispatchTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const { workspacePath, issue, onEvent } = this.options;

    switch (name) {
      case "bash": {
        const command = String(input["command"] ?? "");
        const result = await executeBash(command, workspacePath);
        const parts: string[] = [];
        if (result.stdout) parts.push(result.stdout);
        if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
        if (result.exit_code !== 0) parts.push(`[exit_code: ${result.exit_code}]`);
        return parts.join("\n") || "(no output)";
      }

      case "read_file": {
        const filePath = String(input["path"] ?? "");
        try {
          return await readWorkspaceFile(filePath, workspacePath);
        } catch (err) {
          return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case "write_file": {
        const filePath = String(input["path"] ?? "");
        const content = String(input["content"] ?? "");
        try {
          await writeWorkspaceFile(filePath, content, workspacePath);
          return `Wrote ${content.length} bytes to ${filePath}`;
        } catch (err) {
          return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case "list_directory": {
        const dirPath = String(input["path"] ?? ".");
        try {
          const entries = await listWorkspaceDir(dirPath, workspacePath);
          if (entries.length === 0) return "(empty directory)";
          return entries
            .map((e) => `${e.type === "directory" ? "d" : "-"} ${e.name}`)
            .join("\n");
        } catch (err) {
          return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case "jira_api": {
        const { jiraClient } = this.options;
        if (!jiraClient) {
          return JSON.stringify({ success: false, error: "jira_api tool is not configured" });
        }
        return executeJiraTool(input, jiraClient);
      }

      default:
        onEvent(issue.id, {
          event: "unsupported_tool_call",
          timestamp: new Date(),
          codex_app_server_pid: null,
          tool_name: name,
        });
        return `Error: Unknown tool '${name}'`;
    }
  }
}
