import { spawn } from "child_process";

export interface BashResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

/**
 * Patterns for commands that would modify or destroy the main branch.
 * Agents may merge FROM main into their branch, but must never push TO main
 * or delete/reset it.
 */
const MAIN_BRANCH_FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  {
    // git push [opts] [remote] main  OR  git push [opts] [remote] <src>:main
    pattern: /\bgit\s+push\b[^#\n]*\s(?:HEAD:|[\w./]+:)?main\b/,
    reason: "direct push to main branch is not permitted",
  },
  {
    // git push [opts] [remote] master
    pattern: /\bgit\s+push\b[^#\n]*\s(?:HEAD:|[\w./]+:)?master\b/,
    reason: "direct push to master branch is not permitted",
  },
  {
    // git branch -d/-D main  or  git branch --delete main
    pattern: /\bgit\s+branch\b[^#\n]*\s(?:-[dD]|-{1,2}(?:force-)?delete)\s+[^#\n]*\bmain\b/,
    reason: "deleting the main branch is not permitted",
  },
  {
    // git checkout -B main  (force-recreate main)
    pattern: /\bgit\s+checkout\b[^#\n]*\s-B\s+main\b/,
    reason: "force-recreating the main branch is not permitted",
  },
  {
    // git reset --hard [anything] when checked out on main
    // We can't know the current branch here, so we block reset --hard to a main ref
    pattern: /\bgit\s+reset\b[^#\n]*--hard[^#\n]*\bmain\b/,
    reason: "hard-resetting main branch is not permitted",
  },
];

export function checkMainBranchProtection(command: string): string | null {
  for (const { pattern, reason } of MAIN_BRANCH_FORBIDDEN) {
    if (pattern.test(command)) {
      return reason;
    }
  }
  return null;
}

export async function executeBash(command: string, cwd: string): Promise<BashResult> {
  const violation = checkMainBranchProtection(command);
  if (violation) {
    return {
      stdout: "",
      stderr: `[symphony] Command blocked: ${violation}`,
      exit_code: 1,
    };
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn("bash", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
      resolve({
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: `[symphony] Command timed out after ${COMMAND_TIMEOUT_MS}ms`,
        exit_code: 124,
      });
    }, COMMAND_TIMEOUT_MS);

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      if (!timedOut) {
        clearTimeout(timer);
        resolve({ stdout: "", stderr: err.message, exit_code: 1 });
      }
    });

    proc.on("close", (code) => {
      if (!timedOut) {
        clearTimeout(timer);
        resolve({
          stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
          stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
          exit_code: code ?? 1,
        });
      }
    });
  });
}
