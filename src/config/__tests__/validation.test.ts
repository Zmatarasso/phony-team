import { buildConfig } from "../configLayer.js";
import { validateDispatchConfig } from "../validation.js";

function validConfig(): ReturnType<typeof buildConfig> {
  return buildConfig({
    tracker: {
      kind: "jira",
      base_url: "https://org.atlassian.net",
      email: "user@example.com",
      api_token: "secret",
      project_key: "PHONY",
    },
    codex: { command: "claude" },
  });
}

describe("validateDispatchConfig", () => {
  it("passes a fully valid config", () => {
    const result = validateDispatchConfig(validConfig());
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails when api_token is empty", () => {
    const config = buildConfig({
      tracker: {
        base_url: "https://org.atlassian.net",
        email: "user@example.com",
        api_token: "",
        project_key: "PHONY",
      },
    });
    const result = validateDispatchConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("api_token"))).toBe(true);
  });

  it("fails when email is empty", () => {
    const config = buildConfig({
      tracker: {
        base_url: "https://org.atlassian.net",
        email: "",
        api_token: "secret",
        project_key: "PHONY",
      },
    });
    const result = validateDispatchConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("email"))).toBe(true);
  });

  it("fails when base_url is empty", () => {
    const config = buildConfig({
      tracker: {
        base_url: "",
        email: "user@example.com",
        api_token: "secret",
        project_key: "PHONY",
      },
    });
    const result = validateDispatchConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("base_url"))).toBe(true);
  });

  it("fails when project_key is empty", () => {
    const config = buildConfig({
      tracker: {
        base_url: "https://org.atlassian.net",
        email: "user@example.com",
        api_token: "secret",
        project_key: "",
      },
    });
    const result = validateDispatchConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("project_key"))).toBe(true);
  });

  it("fails when codex.command is whitespace-only", () => {
    const config = buildConfig({
      tracker: {
        base_url: "https://org.atlassian.net",
        email: "user@example.com",
        api_token: "secret",
        project_key: "PHONY",
      },
      codex: { command: "   " },
    });
    const result = validateDispatchConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("codex.command"))).toBe(true);
  });

  it("accumulates multiple errors", () => {
    const config = buildConfig({});
    const result = validateDispatchConfig(config);
    expect(result.ok).toBe(false);
    // api_token, email, base_url, project_key all missing
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  it("fails when $VAR resolves to empty string", () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv };
    delete process.env["JIRA_API_TOKEN"];
    try {
      const config = buildConfig({ tracker: { api_token: "$JIRA_API_TOKEN" } });
      const result = validateDispatchConfig(config);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("api_token"))).toBe(true);
    } finally {
      process.env = originalEnv;
    }
  });
});
