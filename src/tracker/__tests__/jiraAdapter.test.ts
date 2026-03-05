import { jest } from "@jest/globals";
import { JiraAdapter } from "../jiraAdapter.js";
import { TrackerError } from "../../types/errors.js";
import type { TrackerConfig } from "../../types/config.js";

const testConfig: TrackerConfig = {
  kind: "jira",
  base_url: "https://test.atlassian.net",
  email: "test@example.com",
  api_token: "test-token",
  space_key: "PHONY",
  active_states: ["In Progress", "Todo"],
  terminal_states: ["Done", "Cancelled"],
};

function makeIssueRaw(id: string, key: string, statusName: string) {
  return {
    id,
    key,
    self: `https://test.atlassian.net/rest/api/3/issue/${id}`,
    fields: {
      summary: `Issue ${key}`,
      description: null,
      status: { name: statusName },
      priority: { id: "3" },
      labels: [{ name: "Alpha" }, { name: "BETA" }],
      issuelinks: [],
      created: "2024-01-01T00:00:00.000Z",
      updated: "2024-01-02T00:00:00.000Z",
    },
  };
}

function mockFetch(responses: object[]): void {
  let callIndex = 0;
  global.fetch = jest.fn().mockImplementation(() => {
    const body = responses[callIndex++] ?? { issues: [], total: 0, startAt: 0, maxResults: 50 };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response);
  });
}

function mockFetchError(status: number, body = "Error"): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ errorMessages: [body] }),
    text: () => Promise.resolve(body),
  } as unknown as Response);
}

function mockFetchNetworkError(): void {
  global.fetch = jest.fn().mockRejectedValue(new Error("Network failure"));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("JiraAdapter.fetchCandidateIssues", () => {
  it("returns normalized issues from a single page", async () => {
    mockFetch([
      {
        issues: [makeIssueRaw("1", "PHONY-1", "In Progress")],
        total: 1,
        startAt: 0,
        maxResults: 50,
      },
    ]);
    const adapter = new JiraAdapter(testConfig);
    const issues = await adapter.fetchCandidateIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.identifier).toBe("PHONY-1");
    expect(issues[0]?.state).toBe("In Progress");
  });

  it("normalizes labels to lowercase", async () => {
    mockFetch([
      {
        issues: [makeIssueRaw("1", "PHONY-1", "In Progress")],
        total: 1,
        startAt: 0,
        maxResults: 50,
      },
    ]);
    const adapter = new JiraAdapter(testConfig);
    const issues = await adapter.fetchCandidateIssues();
    expect(issues[0]?.labels).toEqual(["alpha", "beta"]);
  });

  it("paginates correctly and preserves order", async () => {
    const page1 = {
      issues: [makeIssueRaw("1", "PHONY-1", "In Progress")],
      total: 2,
      startAt: 0,
      maxResults: 1,
      nextPageToken: "page2token",
    };
    const page2 = {
      issues: [makeIssueRaw("2", "PHONY-2", "Todo")],
      total: 2,
      startAt: 1,
      maxResults: 1,
    };
    mockFetch([page1, page2]);

    const adapter = new JiraAdapter(testConfig);
    const issues = await adapter.fetchCandidateIssues();
    expect(issues).toHaveLength(2);
    expect(issues[0]?.identifier).toBe("PHONY-1");
    expect(issues[1]?.identifier).toBe("PHONY-2");
  });

  it("throws TrackerError with code jira_api_status on non-200 response", async () => {
    mockFetchError(401, "Unauthorized");
    const adapter = new JiraAdapter(testConfig);
    await expect(adapter.fetchCandidateIssues()).rejects.toThrow(TrackerError);
    await expect(adapter.fetchCandidateIssues()).rejects.toMatchObject({
      code: "jira_api_status",
    });
  });

  it("throws TrackerError with code jira_api_request on network failure", async () => {
    mockFetchNetworkError();
    const adapter = new JiraAdapter(testConfig);
    await expect(adapter.fetchCandidateIssues()).rejects.toThrow(TrackerError);
    await expect(adapter.fetchCandidateIssues()).rejects.toMatchObject({
      code: "jira_api_request",
    });
  });

  it("throws TrackerError with code jira_unknown_payload when issues field is missing", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ notIssues: [] }),
      text: () => Promise.resolve("{}"),
    } as unknown as Response);
    const adapter = new JiraAdapter(testConfig);
    await expect(adapter.fetchCandidateIssues()).rejects.toMatchObject({
      code: "jira_unknown_payload",
    });
  });
});

describe("JiraAdapter.fetchIssuesByStates", () => {
  it("returns [] without making an API call when states is empty", async () => {
    global.fetch = jest.fn();
    const adapter = new JiraAdapter(testConfig);
    const result = await adapter.fetchIssuesByStates([]);
    expect(result).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetches issues for given states", async () => {
    mockFetch([
      {
        issues: [makeIssueRaw("3", "PHONY-3", "Done")],
        total: 1,
        startAt: 0,
        maxResults: 50,
      },
    ]);
    const adapter = new JiraAdapter(testConfig);
    const result = await adapter.fetchIssuesByStates(["Done"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.state).toBe("Done");
  });
});

describe("JiraAdapter.fetchIssueStatesByIds", () => {
  it("returns [] without an API call when ids is empty", async () => {
    global.fetch = jest.fn();
    const adapter = new JiraAdapter(testConfig);
    const result = await adapter.fetchIssueStatesByIds([]);
    expect(result).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns id, identifier, state for given issue IDs", async () => {
    mockFetch([
      {
        issues: [makeIssueRaw("10", "PHONY-10", "In Review")],
        total: 1,
        startAt: 0,
        maxResults: 50,
      },
    ]);
    const adapter = new JiraAdapter(testConfig);
    const result = await adapter.fetchIssueStatesByIds(["10"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: "10", identifier: "PHONY-10", state: "In Review" });
  });
});
