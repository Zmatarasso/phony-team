import { writeFile, unlink, mkdtemp } from "fs/promises";
import path from "path";
import os from "os";
import { loadWorkflow, parseWorkflowContent } from "../workflowLoader.js";
import {
  MissingWorkflowFileError,
  WorkflowParseError,
  WorkflowFrontMatterNotAMapError,
} from "../../types/errors.js";

// --- parseWorkflowContent (pure, no I/O) ---

describe("parseWorkflowContent", () => {
  it("returns empty config and full content as prompt when there is no front matter", () => {
    const result = parseWorkflowContent("You are an agent.\nDo things.");
    expect(result.config).toEqual({});
    expect(result.prompt_template).toBe("You are an agent.\nDo things.");
  });

  it("trims prompt body", () => {
    const result = parseWorkflowContent("  \n  hello  \n  ");
    expect(result.prompt_template).toBe("hello");
  });

  it("parses YAML front matter and extracts prompt body", () => {
    const content = [
      "---",
      "tracker:",
      "  kind: jira",
      "  project_key: PHONY",
      "---",
      "",
      "You are an agent.",
    ].join("\n");
    const result = parseWorkflowContent(content);
    expect(result.config).toEqual({ tracker: { kind: "jira", project_key: "PHONY" } });
    expect(result.prompt_template).toBe("You are an agent.");
  });

  it("treats entire file as prompt when opening --- has no closing ---", () => {
    const content = "---\ntracker:\n  kind: jira\nNo closing delimiter";
    const result = parseWorkflowContent(content);
    expect(result.config).toEqual({});
    expect(result.prompt_template).toBe(content.trim());
  });

  it("returns empty config for empty front matter block", () => {
    const content = "---\n---\nPrompt here.";
    const result = parseWorkflowContent(content);
    expect(result.config).toEqual({});
    expect(result.prompt_template).toBe("Prompt here.");
  });

  it("returns empty prompt_template when there is no body after front matter", () => {
    const content = "---\ntracker:\n  kind: jira\n---\n";
    const result = parseWorkflowContent(content);
    expect(result.prompt_template).toBe("");
  });

  it("throws WorkflowParseError for invalid YAML", () => {
    const content = "---\n: invalid: yaml: [\n---\nPrompt.";
    expect(() => parseWorkflowContent(content)).toThrow(WorkflowParseError);
  });

  it("throws WorkflowFrontMatterNotAMapError when front matter is a YAML array", () => {
    const content = "---\n- one\n- two\n---\nPrompt.";
    expect(() => parseWorkflowContent(content)).toThrow(WorkflowFrontMatterNotAMapError);
  });

  it("throws WorkflowFrontMatterNotAMapError when front matter is a scalar", () => {
    const content = "---\njust a string\n---\nPrompt.";
    expect(() => parseWorkflowContent(content)).toThrow(WorkflowFrontMatterNotAMapError);
  });

  it("preserves nested config objects", () => {
    const content = [
      "---",
      "tracker:",
      "  kind: jira",
      "  active_states:",
      "    - In Progress",
      "    - Todo",
      "agent:",
      "  max_concurrent_agents: 5",
      "---",
      "Do the work.",
    ].join("\n");
    const result = parseWorkflowContent(content);
    expect((result.config["tracker"] as Record<string, unknown>)["kind"]).toBe("jira");
    expect((result.config["agent"] as Record<string, unknown>)["max_concurrent_agents"]).toBe(5);
    expect(result.prompt_template).toBe("Do the work.");
  });
});

// --- loadWorkflow (I/O) ---

describe("loadWorkflow", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
  });

  afterEach(async () => {
    // Best-effort cleanup
    try {
      const files = ["WORKFLOW.md"];
      for (const f of files) {
        await unlink(path.join(tmpDir, f)).catch(() => undefined);
      }
    } catch {
      // ignore
    }
  });

  it("loads and parses a valid WORKFLOW.md", async () => {
    const filePath = path.join(tmpDir, "WORKFLOW.md");
    await writeFile(
      filePath,
      "---\ntracker:\n  project_key: TEST\n---\nDo the work.",
    );
    const result = await loadWorkflow(filePath);
    expect((result.config["tracker"] as Record<string, unknown>)["project_key"]).toBe("TEST");
    expect(result.prompt_template).toBe("Do the work.");
  });

  it("throws MissingWorkflowFileError for a non-existent path", async () => {
    await expect(
      loadWorkflow(path.join(tmpDir, "does-not-exist.md")),
    ).rejects.toThrow(MissingWorkflowFileError);
  });

  it("uses cwd default path naming — loadWorkflow respects the passed path", async () => {
    const filePath = path.join(tmpDir, "CUSTOM.md");
    await writeFile(filePath, "Custom prompt.");
    const result = await loadWorkflow(filePath);
    expect(result.prompt_template).toBe("Custom prompt.");
  });
});
