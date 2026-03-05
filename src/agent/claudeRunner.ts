import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import type { ServiceConfig } from "../types/config.js";
import type { Issue } from "../types/domain.js";
import type { AgentEventCallback, TokenUsage } from "../types/events.js";
import type { Logger } from "../logging/logger.js";
import type { JiraClient } from "../tracker/jiraClient.js";
import { AgentRunnerError } from "../types/errors.js";
import { executeBash } from "./tools/bashExecute.js";
import { readWorkspaceFile, writeWorkspaceFile, listWorkspaceDir } from "./tools/fileOps.js";
import { JIRA_TOOL_DEFINITION, executeJiraTool } from "./tools/jiraTool.js";

const BASE_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "bash",
    description:
      "Execute a shell command in the workspace directory. The command runs with the workspace root as cwd.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file. Path may be relative to workspace root or absolute.",
    input_schema: {
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
  {
    name: "write_file",
    description:
      "Write text content to a file. Creates the file if it does not exist; overwrites if it does.",
    input_schema: {
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
  {
    name: "list_directory",
    description: "List files and subdirectories at a given path.",
    input_schema: {
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
];

export interface AgentRunnerOptions {
  readonly config: ServiceConfig;
  readonly apiKey: string;
  readonly workspacePath: string;
  readonly issue: Issue;
  readonly systemPrompt: string;
  readonly attempt: number | null;
  readonly onEvent: AgentEventCallback;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  /** When provided, the jira_api tool is added to the session. */
  readonly jiraClient?: JiraClient;
}

export class AgentRunner {
  private readonly client: Anthropic;
  private readonly tools: Anthropic.Tool[];

  constructor(
    private readonly options: AgentRunnerOptions,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey: options.apiKey });
    this.tools = options.jiraClient
      ? [...BASE_TOOL_DEFINITIONS, JIRA_TOOL_DEFINITION]
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

    const messages: Anthropic.MessageParam[] = [
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

      let response: Anthropic.Message;
      try {
        response = await this.callApi(messages, systemPrompt, turnTimeoutMs);
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

      // Accumulate and report token usage
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
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

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "max_tokens") {
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

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
        const turnUsage: TokenUsage = {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          total_tokens: response.usage.input_tokens + response.usage.output_tokens,
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
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        onEvent(issue.id, {
          event: "approval_auto_approved",
          timestamp: new Date(),
          codex_app_server_pid: null,
          tool_name: block.name,
        });
        const resultContent = await this.dispatchTool(
          block.name,
          block.input as Record<string, unknown>,
        );
        logger.debug(`Tool ${block.name} completed`, { issue_id: issue.id });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: resultContent,
        });
      }
      messages.push({ role: "user", content: toolResults });
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
    messages: Anthropic.MessageParam[],
    system: string,
    timeoutMs: number,
  ): Promise<Anthropic.Message> {
    const controller = new AbortController();
    const outerSignal = this.options.signal;
    if (outerSignal?.aborted) {
      controller.abort();
    } else {
      outerSignal?.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.client.messages.create(
        {
          model: "claude-opus-4-6",
          max_tokens: 8096,
          system,
          messages,
          tools: this.tools,
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
