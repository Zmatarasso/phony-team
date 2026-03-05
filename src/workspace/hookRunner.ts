import { spawn } from "child_process";
import { WorkspaceError } from "../types/errors.js";

export interface HookResult {
  readonly stdout: string;
  readonly stderr: string;
}

const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB log truncation limit

/**
 * Runs a shell script via `bash -lc` in the given working directory.
 * Enforces a hard timeout. Returns stdout/stderr on success.
 * Throws WorkspaceError on non-zero exit, timeout, or spawn failure.
 */
export async function runHook(
  script: string,
  cwd: string,
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let stdout = "";
    let stderr = "";

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("bash", ["-lc", script], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...extraEnv },
      });
    } catch (err) {
      reject(
        new WorkspaceError("workspace_hook_failed", `Failed to spawn hook: ${String(err)}`, err),
      );
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
      reject(
        new WorkspaceError(
          "workspace_hook_timeout",
          `Hook timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString();
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString();
      }
    });

    proc.on("error", (err) => {
      if (!timedOut) {
        clearTimeout(timer);
        reject(
          new WorkspaceError(
            "workspace_hook_failed",
            `Hook process error: ${err.message}`,
            err,
          ),
        );
      }
    });

    proc.on("close", (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new WorkspaceError(
            "workspace_hook_failed",
            `Hook exited with code ${String(code)}: ${stderr.slice(0, 500)}`,
          ),
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
