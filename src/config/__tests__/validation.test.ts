import { buildConfig } from "../configLayer.js";
import { validateDispatchConfig } from "../validation.js";

function validConfig(): ReturnType<typeof buildConfig> {
  return buildConfig({
    tracker: {
      kind: "jira",
      base_url: "https://org.atlassian.net",
      email: "user@example.com",
      api_token: "secret",
      space_key: "PHONY",
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
        space_key: "PHONY",
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
        space_key: "PHONY",
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
        space_key: "PHONY",
      },
    });
    const result = validateDispatchConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("base_url"))).toBe(true);
  });

  it("fails when space_key is empty", () => {
    const config = buildConfig({
      tracker: {
        base_url: "https://org.atlassian.net",
        email: "user@example.com",
        api_token: "secret",
        space_key: "",
      },
    });
    const result = validateDispatchConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("space_key"))).toBe(true);
  });

  it("fails when codex.command is whitespace-only", () => {
    const config = buildConfig({
      tracker: {
        base_url: "https://org.atlassian.net",
        email: "user@example.com",
        api_token: "secret",
        space_key: "PHONY",
      },
      codex: { command: "   " },
    });
    const result = validateDispatchConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("codex.command"))).toBe(true);
  });

  it("accumulates multiple errors", () => {
    // Clear env vars that buildConfig({}) would resolve via $JIRA_* defaults,
    // so that all tracker fields end up empty and validation catches them all.
    const savedApiToken = process.env["JIRA_API_TOKEN"];
    const savedEmail = process.env["JIRA_EMAIL"];
    const savedBaseUrl = process.env["JIRA_BASE_URL"];
    delete process.env["JIRA_API_TOKEN"];
    delete process.env["JIRA_EMAIL"];
    delete process.env["JIRA_BASE_URL"];
    try {
      const config = buildConfig({});
      const result = validateDispatchConfig(config);
      expect(result.ok).toBe(false);
      // api_token, email, base_url, space_key all missing
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    } finally {
      // Restore env vars
      if (savedApiToken !== undefined) process.env["JIRA_API_TOKEN"] = savedApiToken;
      if (savedEmail !== undefined) process.env["JIRA_EMAIL"] = savedEmail;
      if (savedBaseUrl !== undefined) process.env["JIRA_BASE_URL"] = savedBaseUrl;
    }
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
