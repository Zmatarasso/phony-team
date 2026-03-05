import { spawn } from "child_process";
import { writeFile, mkdtemp, rm } from "fs/promises";
import path from "path";
import os from "os";
import { parseArgs } from "../index.js";

// --- parseArgs unit tests ---

describe("parseArgs", () => {
  it("defaults to ./WORKFLOW.md and no port", () => {
    const args = parseArgs(["node", "symphony"]);
    expect(args.workflowPath).toBe("./WORKFLOW.md");
    expect(args.port).toBeNull();
  });

  it("accepts a positional workflow path", () => {
    const args = parseArgs(["node", "symphony", "/custom/WORKFLOW.md"]);
    expect(args.workflowPath).toBe("/custom/WORKFLOW.md");
  });

  it("parses --port flag", () => {
    const args = parseArgs(["node", "symphony", "--port", "3000"]);
    expect(args.port).toBe(3000);
  });

  it("accepts workflow path alongside --port", () => {
    const args = parseArgs(["node", "symphony", "path/to/WORKFLOW.md", "--port", "8080"]);
    expect(args.workflowPath).toBe("path/to/WORKFLOW.md");
    expect(args.port).toBe(8080);
  });

  it("--port before workflow path", () => {
    const args = parseArgs(["node", "symphony", "--port", "4000", "WORKFLOW.md"]);
    expect(args.port).toBe(4000);
    expect(args.workflowPath).toBe("WORKFLOW.md");
  });
});

// --- Subprocess integration tests ---

/** Spawn the CLI via tsx and collect exit code + stderr. */
function runCli(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 5_000,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      "node",
      ["--import", "tsx/esm", "src/cli/index.ts", ...args],
      {
        cwd: path.resolve(process.cwd()),
        env: { ...process.env, ANTHROPIC_API_KEY: undefined, ...env },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ code: -1, stderr });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
  });
}

describe("CLI startup errors", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "symphony-cli-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("exits 1 when workflow file does not exist", async () => {
    const { code, stderr } = await runCli([path.join(tmpDir, "MISSING.md")]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/error/i);
  });

  it("exits 1 when ANTHROPIC_API_KEY is missing", async () => {
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  kind: jira",
        "  base_url: https://example.atlassian.net",
        "  email: user@example.com",
        "  api_token: token",
        "  project_key: PHONY",
        "---",
        "Work on {{ issue.identifier }}.",
      ].join("\n"),
    );
    const { code, stderr } = await runCli([workflowPath], { ANTHROPIC_API_KEY: "" });
    expect(code).toBe(1);
    expect(stderr).toMatch(/ANTHROPIC_API_KEY/i);
  });

  it("exits 1 when workflow config is invalid (missing required fields)", async () => {
    const workflowPath = path.join(tmpDir, "WORKFLOW.md");
    // Valid YAML but missing required tracker fields
    await writeFile(workflowPath, "---\ntracker:\n  kind: jira\n---\nPrompt.");
    const { code, stderr } = await runCli([workflowPath], {
      ANTHROPIC_API_KEY: "test-key",
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/error/i);
  });
});
