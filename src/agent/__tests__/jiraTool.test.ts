import { jest } from "@jest/globals";
import { executeJiraTool, JIRA_TOOL_DEFINITION } from "../tools/jiraTool.js";
import type { JiraClient } from "../../tracker/jiraClient.js";
import { TrackerError } from "../../types/errors.js";

function makeMockClient(
  impl: (method: string, endpoint: string, body?: Record<string, unknown>) => Promise<unknown>,
): JiraClient {
  return {
    request: jest.fn<typeof impl>().mockImplementation(impl),
  } as unknown as JiraClient;
}

// --- Tool definition shape ---

describe("JIRA_TOOL_DEFINITION", () => {
  it("has name jira_api", () => {
    expect(JIRA_TOOL_DEFINITION.name).toBe("jira_api");
  });

  it("requires method and endpoint", () => {
    expect(JIRA_TOOL_DEFINITION.input_schema.required).toEqual(
      expect.arrayContaining(["method", "endpoint"]),
    );
  });
});

// --- executeJiraTool ---

describe("executeJiraTool — successful calls", () => {
  it("returns success:true with data on GET", async () => {
    const client = makeMockClient(async () => ({ id: "42", key: "PHONY-42" }));
    const result = JSON.parse(
      await executeJiraTool(
        { method: "GET", endpoint: "/rest/api/3/issue/PHONY-42" },
        client,
      ),
    ) as Record<string, unknown>;
    expect(result["success"]).toBe(true);
    expect((result["data"] as Record<string, unknown>)["key"]).toBe("PHONY-42");
  });

  it("passes body to POST requests", async () => {
    const client = makeMockClient(async (_m, _e, body) => ({ received: body }));
    const result = JSON.parse(
      await executeJiraTool(
        {
          method: "POST",
          endpoint: "/rest/api/3/issue/PHONY-42/comment",
          body: { body: { type: "doc", content: [] } },
        },
        client,
      ),
    ) as Record<string, unknown>;
    expect(result["success"]).toBe(true);
  });

  it("handles PUT requests", async () => {
    const client = makeMockClient(async () => null);
    const result = JSON.parse(
      await executeJiraTool(
        { method: "PUT", endpoint: "/rest/api/3/issue/PHONY-42", body: { fields: {} } },
        client,
      ),
    ) as Record<string, unknown>;
    expect(result["success"]).toBe(true);
  });

  it("passes undefined body when no body field provided", async () => {
    let capturedBody: unknown = "not-called";
    const client = makeMockClient(async (_m, _e, body) => {
      capturedBody = body;
      return {};
    });
    await executeJiraTool({ method: "GET", endpoint: "/rest/api/3/issue/PHONY-1" }, client);
    expect(capturedBody).toBeUndefined();
  });
});

describe("executeJiraTool — input validation", () => {
  it("returns success:false when endpoint is empty", async () => {
    const client = makeMockClient(async () => ({}));
    const result = JSON.parse(
      await executeJiraTool({ method: "GET", endpoint: "" }, client),
    ) as Record<string, unknown>;
    expect(result["success"]).toBe(false);
    expect(result["error"]).toMatch(/endpoint/i);
  });

  it("returns success:false for unsupported method", async () => {
    const client = makeMockClient(async () => ({}));
    const result = JSON.parse(
      await executeJiraTool({ method: "DELETE", endpoint: "/rest/api/3/issue/X" }, client),
    ) as Record<string, unknown>;
    expect(result["success"]).toBe(false);
    expect(result["error"]).toMatch(/unsupported method/i);
  });

  it("returns success:false when method is missing", async () => {
    const client = makeMockClient(async () => ({}));
    const result = JSON.parse(
      await executeJiraTool({ endpoint: "/rest/api/3/issue/X" }, client),
    ) as Record<string, unknown>;
    expect(result["success"]).toBe(false);
  });
});

describe("executeJiraTool — error handling", () => {
  it("returns success:false when JiraClient throws TrackerError", async () => {
    const client = makeMockClient(async () => {
      throw new TrackerError("jira_api_status", "Jira API returned HTTP 404 for GET /x: Not Found");
    });
    const result = JSON.parse(
      await executeJiraTool({ method: "GET", endpoint: "/rest/api/3/issue/X" }, client),
    ) as Record<string, unknown>;
    expect(result["success"]).toBe(false);
    expect(typeof result["error"]).toBe("string");
  });

  it("does not expose Basic auth credentials in error messages", async () => {
    const client = makeMockClient(async () => {
      throw new Error("Authorization failed: Basic dXNlcjpzZWNyZXQ= was rejected");
    });
    const result = JSON.parse(
      await executeJiraTool({ method: "GET", endpoint: "/rest/api/3/issue/X" }, client),
    ) as Record<string, unknown>;
    expect(result["success"]).toBe(false);
    expect(String(result["error"])).not.toMatch(/dXNlcjpzZWNyZXQ=/);
    expect(String(result["error"])).toContain("[redacted]");
  });

  it("returns success:false on network error", async () => {
    const client = makeMockClient(async () => {
      throw new TrackerError("jira_api_request", "fetch failed: ECONNREFUSED");
    });
    const result = JSON.parse(
      await executeJiraTool({ method: "GET", endpoint: "/rest/api/3/issue/X" }, client),
    ) as Record<string, unknown>;
    expect(result["success"]).toBe(false);
    expect(String(result["error"])).toContain("ECONNREFUSED");
  });
});
