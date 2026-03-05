import type { JiraClient } from "../../tracker/jiraClient.js";
import type Anthropic from "@anthropic-ai/sdk";

export const JIRA_TOOL_DEFINITION: Anthropic.Tool = {
  name: "jira_api",
  description:
    "Call the Jira REST API v3. Use this to transition issue states, add comments, look up " +
    "related issues, or post PR links. The API is pre-authenticated — never include credentials.",
  input_schema: {
    type: "object",
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT"],
        description: "HTTP method",
      },
      endpoint: {
        type: "string",
        description:
          "Jira REST API v3 path, e.g. /rest/api/3/issue/PHONY-42/transitions",
      },
      body: {
        type: "object",
        description: "Request body for POST/PUT requests",
        additionalProperties: true,
      },
    },
    required: ["method", "endpoint"],
  },
};

/** Strip Basic auth tokens from error messages before returning them to the agent. */
function sanitizeError(msg: string): string {
  return msg.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "[redacted]");
}

export async function executeJiraTool(
  input: Record<string, unknown>,
  client: JiraClient,
): Promise<string> {
  const method = String(input["method"] ?? "");
  const endpoint = String(input["endpoint"] ?? "");
  const body = typeof input["body"] === "object" && input["body"] !== null
    ? (input["body"] as Record<string, unknown>)
    : undefined;

  if (!endpoint) {
    return JSON.stringify({ success: false, error: "endpoint is required" });
  }
  if (method !== "GET" && method !== "POST" && method !== "PUT") {
    return JSON.stringify({ success: false, error: `Unsupported method: ${method}` });
  }

  try {
    const data = await client.request<unknown>(method, endpoint, body);
    return JSON.stringify({ success: true, data });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ success: false, error: sanitizeError(raw) });
  }
}
