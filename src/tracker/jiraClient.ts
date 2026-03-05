import { TrackerError } from "../types/errors.js";

export interface JiraClientConfig {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
}

const NETWORK_TIMEOUT_MS = 30_000;

export class JiraClient {
  private readonly authHeader: string;
  private readonly baseUrl: string;

  constructor(config: JiraClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
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
