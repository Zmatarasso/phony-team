import { TrackerError } from "../types/errors.js";

export interface JiraClientConfig {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  readonly onRequest?: (method: string, path: string) => void;
}

const NETWORK_TIMEOUT_MS = 30_000;

export class JiraClient {
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly onRequest: ((method: string, path: string) => void) | undefined;

  constructor(config: JiraClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;
    this.onRequest = config.onRequest;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    this.onRequest?.(method, path);
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      throw new TrackerError(
        "jira_api_request",
        `Jira API request failed: ${String(err)}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After") ?? "unknown";
        throw new TrackerError(
          "jira_api_status",
          `Jira rate limit hit (429) — retry after ${retryAfter}s. Consider increasing polling.interval_ms in WORKFLOW.md.`,
        );
      }
      if (response.status === 401) {
        throw new TrackerError(
          "jira_api_status",
          `Jira authentication failed (401) — check that JIRA_EMAIL and JIRA_API_TOKEN are correct. ` +
          `API tokens are created at: id.atlassian.com/manage-profile/security/api-tokens`,
        );
      }
      if (response.status === 403) {
        throw new TrackerError(
          "jira_api_status",
          `Jira access denied (403) — the account may not have permission to access this space. ` +
          `Check that JIRA_EMAIL has access to space "${this.baseUrl}".`,
        );
      }
      throw new TrackerError(
        "jira_api_status",
        `Jira API returned HTTP ${response.status} for ${method} ${path}: ${text}`,
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      throw new TrackerError(
        "jira_unknown_payload",
        `Failed to parse Jira API response as JSON: ${String(err)}`,
        err,
      );
    }

    return data as T;
  }
}
