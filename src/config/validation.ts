import type { ServiceConfig, ValidationResult } from "../types/config.js";

export function validateDispatchConfig(config: ServiceConfig): ValidationResult {
  const errors: string[] = [];

  if (config.tracker.kind !== "jira") {
    errors.push(
      `tracker.kind "${String(config.tracker.kind)}" is not supported; only "jira" is supported`,
    );
  }

  if (!config.tracker.api_token) {
    errors.push(
      "tracker.api_token is missing or empty (set JIRA_API_TOKEN or provide a value in WORKFLOW.md)",
    );
  }

  if (!config.tracker.email) {
    errors.push(
      "tracker.email is missing or empty (set JIRA_EMAIL or provide a value in WORKFLOW.md)",
    );
  }

  if (!config.tracker.base_url) {
    errors.push(
      "tracker.base_url is missing or empty (set JIRA_BASE_URL or provide a value in WORKFLOW.md)",
    );
  }

  if (!config.tracker.space_key) {
    errors.push("tracker.space_key is required (set this to your Jira space key, e.g. ZMATA)");
  }

  if (!config.codex.command.trim()) {
    errors.push("codex.command must be a non-empty string");
  }

  if (config.agent.backend === "grok" && !config.grok.api_key) {
    errors.push(
      "grok.api_key is missing or empty (set XAI_API_KEY or provide a value in WORKFLOW.md)",
    );
  }

  return { ok: errors.length === 0, errors };
}
