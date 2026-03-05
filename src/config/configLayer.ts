import os from "os";
import path from "path";
import type {
  ServiceConfig,
  TrackerConfig,
  PollingConfig,
  WorkspaceConfig,
  HooksConfig,
  AgentConfig,
  CodexConfig,
  GrokConfig,
  ServerConfig,
} from "../types/config.js";

const DEFAULT_AGENT_BACKEND = "claude" as const;
const DEFAULT_GROK_MODEL = "grok-2-1212";

// --- Defaults ---

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"] as const;
const DEFAULT_TERMINAL_STATES = [
  "Done",
  "Cancelled",
  "Closed",
  "Duplicate",
] as const;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_WORKSPACE_ROOT = path.join(os.tmpdir(), "symphony_workspaces");
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const DEFAULT_STALL_TIMEOUT_MS = 300_000;
// We use the Anthropic SDK directly; this field is kept for spec conformance
// and future extensibility (e.g. swapping to a subprocess-based runner).
const DEFAULT_CODEX_COMMAND = "claude";

// --- Helpers ---

/**
 * If the value is a string starting with $, resolve it from the environment.
 * Returns empty string if the env var is unset or empty.
 */
function resolveEnvVar(value: string): string {
  if (value.startsWith("$")) {
    const varName = value.slice(1);
    return process.env[varName] ?? "";
  }
  return value;
}

/**
 * Expand ~ and $VAR_NAME references in a filesystem path string.
 * Only applies to values that are intended as local filesystem paths;
 * URIs and command strings are not expanded.
 */
function expandPath(value: string): string {
  let result = value;
  if (result === "~" || result.startsWith("~/") || result.startsWith("~\\")) {
    result = os.homedir() + result.slice(1);
  }
  // Expand $VAR inline (for paths like $HOME/workspaces)
  result = result.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, varName: string) => {
    return process.env[varName] ?? "";
  });
  return path.normalize(result);
}

/**
 * Coerce a value to a positive integer, falling back to defaultValue if invalid.
 */
function coercePositiveInt(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return defaultValue;
}

/**
 * Coerce a value to a non-negative integer, falling back to defaultValue.
 */
function coerceNonNegativeInt(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  return defaultValue;
}

/**
 * Parse a states list from either an array or a comma-separated string.
 */
function parseStates(value: unknown, defaults: readonly string[]): readonly string[] {
  if (value === undefined || value === null) return defaults;
  if (typeof value === "string") {
    const parts = value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts : defaults;
  }
  if (Array.isArray(value)) {
    return value.map((s) => String(s));
  }
  return defaults;
}

/**
 * Parse the per-state concurrency map.
 * Keys are normalized (trim + lowercase), invalid/non-positive values are ignored.
 */
function parsePerStateConcurrency(value: unknown): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return result;
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.trim().toLowerCase();
    const n =
      typeof val === "number"
        ? val
        : typeof val === "string"
          ? parseInt(val, 10)
          : NaN;
    if (!isNaN(n) && n > 0) {
      result.set(normalizedKey, Math.floor(n));
    }
  }
  return result;
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function getObject(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const v = obj[key];
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

function getHookScript(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v === "string" && v.trim().length > 0) return v;
  return null;
}

// --- Main export ---

export function buildConfig(raw: Record<string, unknown>): ServiceConfig {
  const trackerRaw = getObject(raw, "tracker");
  const pollingRaw = getObject(raw, "polling");
  const workspaceRaw = getObject(raw, "workspace");
  const hooksRaw = getObject(raw, "hooks");
  const agentRaw = getObject(raw, "agent");
  const codexRaw = getObject(raw, "codex");
  const grokRaw = getObject(raw, "grok");
  const serverRaw = getObject(raw, "server");

  // tracker
  const rawApiToken = getString(trackerRaw, "api_token") ?? "$JIRA_API_TOKEN";
  const rawEmail = getString(trackerRaw, "email") ?? "$JIRA_EMAIL";
  const rawBaseUrl = getString(trackerRaw, "base_url") ?? "$JIRA_BASE_URL";

  const tracker: TrackerConfig = {
    kind: "jira",
    base_url: resolveEnvVar(rawBaseUrl),
    email: resolveEnvVar(rawEmail),
    api_token: resolveEnvVar(rawApiToken),
    project_key: getString(trackerRaw, "project_key") ?? "",
    active_states: parseStates(trackerRaw["active_states"], DEFAULT_ACTIVE_STATES),
    terminal_states: parseStates(trackerRaw["terminal_states"], DEFAULT_TERMINAL_STATES),
  };

  // polling
  const polling: PollingConfig = {
    interval_ms: coercePositiveInt(pollingRaw["interval_ms"], DEFAULT_POLL_INTERVAL_MS),
  };

  // workspace
  const rawRoot = getString(workspaceRaw, "root") ?? DEFAULT_WORKSPACE_ROOT;
  const workspace: WorkspaceConfig = {
    root: expandPath(rawRoot),
  };

  // hooks
  const hooks: HooksConfig = {
    after_create: getHookScript(hooksRaw, "after_create"),
    before_run: getHookScript(hooksRaw, "before_run"),
    after_run: getHookScript(hooksRaw, "after_run"),
    before_remove: getHookScript(hooksRaw, "before_remove"),
    timeout_ms: coercePositiveInt(hooksRaw["timeout_ms"], DEFAULT_HOOK_TIMEOUT_MS),
  };

  // agent
  const rawBackend = getString(agentRaw, "backend");
  const backend: "claude" | "grok" =
    rawBackend === "grok" ? "grok" : DEFAULT_AGENT_BACKEND;

  const agent: AgentConfig = {
    max_concurrent_agents: coercePositiveInt(
      agentRaw["max_concurrent_agents"],
      DEFAULT_MAX_CONCURRENT_AGENTS,
    ),
    max_turns: coercePositiveInt(agentRaw["max_turns"], DEFAULT_MAX_TURNS),
    max_retry_backoff_ms: coercePositiveInt(
      agentRaw["max_retry_backoff_ms"],
      DEFAULT_MAX_RETRY_BACKOFF_MS,
    ),
    max_concurrent_agents_by_state: parsePerStateConcurrency(
      agentRaw["max_concurrent_agents_by_state"],
    ),
    backend,
  };

  // codex (agent subprocess settings — kept for spec conformance)
  const rawCommand = getString(codexRaw, "command") ?? DEFAULT_CODEX_COMMAND;
  const codex: CodexConfig = {
    command: rawCommand,
    turn_timeout_ms: coercePositiveInt(
      codexRaw["turn_timeout_ms"],
      DEFAULT_TURN_TIMEOUT_MS,
    ),
    read_timeout_ms: coercePositiveInt(
      codexRaw["read_timeout_ms"],
      DEFAULT_READ_TIMEOUT_MS,
    ),
    stall_timeout_ms: coerceNonNegativeInt(
      codexRaw["stall_timeout_ms"],
      DEFAULT_STALL_TIMEOUT_MS,
    ),
  };

  // grok
  const rawGrokApiKey = getString(grokRaw, "api_key") ?? "$XAI_API_KEY";
  const grok: GrokConfig = {
    api_key: resolveEnvVar(rawGrokApiKey),
    model: getString(grokRaw, "model") ?? DEFAULT_GROK_MODEL,
  };

  // server (optional extension)
  const rawPort = serverRaw["port"];
  let serverPort: number | undefined;
  if (typeof rawPort === "number" && Number.isFinite(rawPort) && rawPort >= 0) {
    serverPort = Math.floor(rawPort);
  } else if (typeof rawPort === "string") {
    const n = parseInt(rawPort, 10);
    if (!isNaN(n) && n >= 0) serverPort = n;
  }
  const server: ServerConfig = { port: serverPort };

  return { tracker, polling, workspace, hooks, agent, codex, grok, server };
}
