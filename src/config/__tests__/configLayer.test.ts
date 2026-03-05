import os from "os";
import path from "path";
import { buildConfig } from "../configLayer.js";

describe("buildConfig — defaults", () => {
  it("applies all defaults when config is empty", () => {
    const config = buildConfig({});
    expect(config.tracker.kind).toBe("jira");
    expect(config.tracker.active_states).toEqual(["Todo", "In Progress"]);
    expect(config.tracker.terminal_states).toEqual([
      "Done",
      "Cancelled",
      "Closed",
      "Duplicate",
    ]);
    expect(config.polling.interval_ms).toBe(30_000);
    expect(config.workspace.root).toBe(
      path.normalize(path.join(os.tmpdir(), "symphony_workspaces")),
    );
    expect(config.hooks.after_create).toBeNull();
    expect(config.hooks.before_run).toBeNull();
    expect(config.hooks.after_run).toBeNull();
    expect(config.hooks.before_remove).toBeNull();
    expect(config.hooks.timeout_ms).toBe(60_000);
    expect(config.agent.max_concurrent_agents).toBe(10);
    expect(config.agent.max_turns).toBe(20);
    expect(config.agent.max_retry_backoff_ms).toBe(300_000);
    expect(config.agent.max_concurrent_agents_by_state.size).toBe(0);
    expect(config.codex.command).toBe("claude");
    expect(config.codex.turn_timeout_ms).toBe(3_600_000);
    expect(config.codex.read_timeout_ms).toBe(5_000);
    expect(config.codex.stall_timeout_ms).toBe(300_000);
    expect(config.server.port).toBeUndefined();
  });
});

describe("buildConfig — $VAR resolution", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves $JIRA_API_TOKEN from environment", () => {
    process.env["JIRA_API_TOKEN"] = "secret-token";
    const config = buildConfig({ tracker: { api_token: "$JIRA_API_TOKEN" } });
    expect(config.tracker.api_token).toBe("secret-token");
  });

  it("resolves $JIRA_EMAIL from environment", () => {
    process.env["JIRA_EMAIL"] = "user@example.com";
    const config = buildConfig({ tracker: { email: "$JIRA_EMAIL" } });
    expect(config.tracker.email).toBe("user@example.com");
  });

  it("resolves $JIRA_BASE_URL from environment", () => {
    process.env["JIRA_BASE_URL"] = "https://org.atlassian.net";
    const config = buildConfig({ tracker: { base_url: "$JIRA_BASE_URL" } });
    expect(config.tracker.base_url).toBe("https://org.atlassian.net");
  });

  it("returns empty string when $VAR is not set in environment", () => {
    delete process.env["JIRA_API_TOKEN"];
    const config = buildConfig({ tracker: { api_token: "$JIRA_API_TOKEN" } });
    expect(config.tracker.api_token).toBe("");
  });

  it("uses literal value when it does not start with $", () => {
    const config = buildConfig({ tracker: { api_token: "literal-token" } });
    expect(config.tracker.api_token).toBe("literal-token");
  });

  it("auto-resolves default $JIRA_API_TOKEN when no api_token key present", () => {
    process.env["JIRA_API_TOKEN"] = "auto-resolved";
    const config = buildConfig({});
    expect(config.tracker.api_token).toBe("auto-resolved");
  });
});

describe("buildConfig — path expansion", () => {
  it("expands ~ in workspace.root", () => {
    const config = buildConfig({ workspace: { root: "~/my-workspaces" } });
    expect(config.workspace.root).toBe(
      path.normalize(path.join(os.homedir(), "my-workspaces")),
    );
  });

  it("expands $VAR in workspace.root path", () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv, WORK_ROOT: "/custom/root" };
    try {
      const config = buildConfig({ workspace: { root: "$WORK_ROOT/spaces" } });
      expect(config.workspace.root).toBe(path.normalize("/custom/root/spaces"));
    } finally {
      process.env = originalEnv;
    }
  });

  it("preserves absolute path without expansion", () => {
    const config = buildConfig({ workspace: { root: "/absolute/path" } });
    expect(config.workspace.root).toBe(path.normalize("/absolute/path"));
  });
});

describe("buildConfig — active/terminal states", () => {
  it("parses active_states from array", () => {
    const config = buildConfig({
      tracker: { active_states: ["In Progress", "Todo"] },
    });
    expect(config.tracker.active_states).toEqual(["In Progress", "Todo"]);
  });

  it("parses active_states from comma-separated string", () => {
    const config = buildConfig({
      tracker: { active_states: "In Progress, Todo" },
    });
    expect(config.tracker.active_states).toEqual(["In Progress", "Todo"]);
  });

  it("parses terminal_states from array", () => {
    const config = buildConfig({
      tracker: { terminal_states: ["Done", "Cancelled"] },
    });
    expect(config.tracker.terminal_states).toEqual(["Done", "Cancelled"]);
  });

  it("uses defaults when states value is null", () => {
    const config = buildConfig({ tracker: { active_states: null } });
    expect(config.tracker.active_states).toEqual(["Todo", "In Progress"]);
  });
});

describe("buildConfig — integer coercion", () => {
  it("accepts numeric polling.interval_ms", () => {
    const config = buildConfig({ polling: { interval_ms: 60_000 } });
    expect(config.polling.interval_ms).toBe(60_000);
  });

  it("coerces string polling.interval_ms", () => {
    const config = buildConfig({ polling: { interval_ms: "60000" } });
    expect(config.polling.interval_ms).toBe(60_000);
  });

  it("falls back to default for non-numeric string", () => {
    const config = buildConfig({ polling: { interval_ms: "not-a-number" } });
    expect(config.polling.interval_ms).toBe(30_000);
  });

  it("falls back to default for zero (non-positive)", () => {
    const config = buildConfig({ polling: { interval_ms: 0 } });
    expect(config.polling.interval_ms).toBe(30_000);
  });

  it("coerces string max_concurrent_agents", () => {
    const config = buildConfig({ agent: { max_concurrent_agents: "5" } });
    expect(config.agent.max_concurrent_agents).toBe(5);
  });

  it("allows stall_timeout_ms of 0 (disables stall detection)", () => {
    const config = buildConfig({ codex: { stall_timeout_ms: 0 } });
    expect(config.codex.stall_timeout_ms).toBe(0);
  });
});

describe("buildConfig — per-state concurrency", () => {
  it("normalizes state name keys to lowercase and trims them", () => {
    const config = buildConfig({
      agent: {
        max_concurrent_agents_by_state: { " In Progress ": 2, "TODO": 1 },
      },
    });
    expect(config.agent.max_concurrent_agents_by_state.get("in progress")).toBe(2);
    expect(config.agent.max_concurrent_agents_by_state.get("todo")).toBe(1);
  });

  it("ignores non-positive values", () => {
    const config = buildConfig({
      agent: { max_concurrent_agents_by_state: { "in progress": 0, "todo": -1 } },
    });
    expect(config.agent.max_concurrent_agents_by_state.size).toBe(0);
  });

  it("ignores non-numeric values", () => {
    const config = buildConfig({
      agent: { max_concurrent_agents_by_state: { "in progress": "not-a-number" } },
    });
    expect(config.agent.max_concurrent_agents_by_state.size).toBe(0);
  });

  it("returns empty map when key is missing", () => {
    const config = buildConfig({});
    expect(config.agent.max_concurrent_agents_by_state.size).toBe(0);
  });
});

describe("buildConfig — hooks", () => {
  it("parses hook scripts", () => {
    const config = buildConfig({
      hooks: {
        after_create: "git clone $REPO .",
        before_run: "npm install",
        after_run: "echo done",
        before_remove: "rm -rf node_modules",
        timeout_ms: 30_000,
      },
    });
    expect(config.hooks.after_create).toBe("git clone $REPO .");
    expect(config.hooks.before_run).toBe("npm install");
    expect(config.hooks.after_run).toBe("echo done");
    expect(config.hooks.before_remove).toBe("rm -rf node_modules");
    expect(config.hooks.timeout_ms).toBe(30_000);
  });

  it("preserves codex.command as-is (not path-expanded)", () => {
    const config = buildConfig({ codex: { command: "codex app-server --verbose" } });
    expect(config.codex.command).toBe("codex app-server --verbose");
  });
});

describe("buildConfig — server extension", () => {
  it("parses server.port from number", () => {
    const config = buildConfig({ server: { port: 3000 } });
    expect(config.server.port).toBe(3000);
  });

  it("parses server.port from string", () => {
    const config = buildConfig({ server: { port: "3000" } });
    expect(config.server.port).toBe(3000);
  });

  it("allows port 0 (ephemeral)", () => {
    const config = buildConfig({ server: { port: 0 } });
    expect(config.server.port).toBe(0);
  });

  it("leaves port undefined when not set", () => {
    const config = buildConfig({});
    expect(config.server.port).toBeUndefined();
  });

  it("leaves port undefined for invalid value", () => {
    const config = buildConfig({ server: { port: "not-a-port" } });
    expect(config.server.port).toBeUndefined();
  });
});
