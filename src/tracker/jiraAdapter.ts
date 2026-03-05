import { JiraClient } from "./jiraClient.js";
import { normalizeIssue, type RawJiraIssue } from "./normalize.js";
import { TrackerError } from "../types/errors.js";
import type { Issue } from "../types/domain.js";
import type { TrackerConfig } from "../types/config.js";

const PAGE_SIZE = 50;

const ISSUE_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "labels",
  "issuelinks",
  "created",
  "updated",
  "customfield_10014",
].join(",");

interface JiraSearchResponse {
  issues: unknown[];
  total: number;
  startAt: number;
  maxResults: number;
}

export class JiraAdapter {
  private readonly client: JiraClient;
  private readonly config: TrackerConfig;

  constructor(config: TrackerConfig) {
    this.config = config;
    this.client = new JiraClient({
      baseUrl: config.base_url,
      email: config.email,
      apiToken: config.api_token,
    });
  }

  /**
   * Fetch all candidate issues in configured active states for the project.
   * Paginates automatically. Used for dispatch.
   */
  async fetchCandidateIssues(): Promise<Issue[]> {
    const stateList = this.config.active_states.map((s) => `"${s}"`).join(", ");
    const jql = `project = "${this.config.space_key}" AND status in (${stateList}) ORDER BY created ASC`;
    return this.fetchAllByJql(jql);
  }

  /**
   * Fetch issues in the given states. Used for startup terminal cleanup.
   * Returns [] without an API call if states is empty.
   */
  async fetchIssuesByStates(states: readonly string[]): Promise<Issue[]> {
    if (states.length === 0) return [];
    const stateList = states.map((s) => `"${s}"`).join(", ");
    const jql = `project = "${this.config.space_key}" AND status in (${stateList}) ORDER BY created ASC`;
    return this.fetchAllByJql(jql);
  }

  /**
   * Fetch all issues in the space regardless of state. Used for debugging.
   */
  async fetchAllIssues(): Promise<Issue[]> {
    const jql = `project = "${this.config.space_key}" ORDER BY created ASC`;
    return this.fetchAllByJql(jql);
  }

  /**
   * Fetch current state for specific issue IDs. Used for reconciliation.
   * Returns minimal { id, identifier, state } objects.
   */
  async fetchIssueStatesByIds(
    ids: readonly string[],
  ): Promise<Pick<Issue, "id" | "identifier" | "state">[]> {
    if (ids.length === 0) return [];
    // Jira JQL supports filtering by internal issue ID
    const idList = ids.join(", ");
    const jql = `id in (${idList})`;
    const issues = await this.fetchAllByJql(jql);
    return issues.map(({ id, identifier, state }) => ({ id, identifier, state }));
  }

  private async fetchAllByJql(jql: string): Promise<Issue[]> {
    const results: Issue[] = [];
    let startAt = 0;

    while (true) {
      const params = new URLSearchParams({
        jql,
        startAt: String(startAt),
        maxResults: String(PAGE_SIZE),
        fields: ISSUE_FIELDS,
      });

      const data = await this.client.request<JiraSearchResponse>(
        "GET",
        `/rest/api/3/search/jql?${params.toString()}`,
      );

      if (!Array.isArray(data.issues)) {
        throw new TrackerError(
          "jira_unknown_payload",
          "Jira search response missing 'issues' array",
        );
      }

      for (const raw of data.issues) {
        results.push(normalizeIssue(raw as RawJiraIssue));
      }

      const fetched = startAt + data.issues.length;
      if (fetched >= data.total || data.issues.length === 0) break;
      startAt = fetched;
    }

    return results;
  }
}
