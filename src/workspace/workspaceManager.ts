import { mkdir, rm, stat } from "fs/promises";
import path from "path";
import { WorkspaceError } from "../types/errors.js";
import { runHook } from "./hookRunner.js";
import type { WorkspaceInfo } from "../types/domain.js";
import type { HooksConfig, WorkspaceConfig } from "../types/config.js";

/**
 * Replace any character not in [A-Za-z0-9._-] with underscore.
 * Used to derive a safe directory name from an issue identifier.
 */
export function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Compute the absolute workspace path for a given issue identifier.
 * Does NOT create any directories.
 */
export function getWorkspacePath(workspaceRoot: string, identifier: string): string {
  const key = sanitizeIdentifier(identifier);
  return path.resolve(path.join(workspaceRoot, key));
}

/**
 * Assert that workspacePath is strictly contained within workspaceRoot.
 * Throws WorkspaceError if the path escapes the root.
 */
export function assertPathContained(workspaceRoot: string, workspacePath: string): void {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(workspacePath);
  // Must start with root + separator to prevent e.g. /tmp/foo matching /tmp/foobar
  if (!target.startsWith(root + path.sep)) {
    throw new WorkspaceError(
      "workspace_path_invalid",
      `Workspace path "${target}" is outside workspace root "${root}"`,
    );
  }
}

export class WorkspaceManager {
  private readonly workspaceConfig: WorkspaceConfig;
  private readonly hooksConfig: HooksConfig;

  private readonly hookEnv: Record<string, string>;

  constructor(workspaceConfig: WorkspaceConfig, hooksConfig: HooksConfig) {
    this.workspaceConfig = workspaceConfig;
    this.hooksConfig = hooksConfig;
    this.hookEnv = workspaceConfig.repo_url ? { REPO_URL: workspaceConfig.repo_url } : {};
  }

  /**
   * Ensure a workspace directory exists for the given issue identifier.
   * Creates the directory if missing (created_now=true) and runs after_create hook.
   * Reuses the existing directory if already present (created_now=false).
   */
  async ensureWorkspace(identifier: string): Promise<WorkspaceInfo> {
    const workspacePath = getWorkspacePath(this.workspaceConfig.root, identifier);
    const workspaceKey = sanitizeIdentifier(identifier);

    assertPathContained(this.workspaceConfig.root, workspacePath);

    let createdNow = false;
    try {
      const s = await stat(workspacePath);
      if (!s.isDirectory()) {
        throw new WorkspaceError(
          "workspace_creation_failed",
          `Path "${workspacePath}" exists but is not a directory`,
        );
      }
      // Directory already exists — reuse it
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        // Create the directory
        await mkdir(workspacePath, { recursive: true });
        createdNow = true;
      } else if (err instanceof WorkspaceError) {
        throw err;
      } else {
        throw new WorkspaceError(
          "workspace_creation_failed",
          `Failed to stat workspace path: ${String(err)}`,
          err,
        );
      }
    }

    if (createdNow && this.hooksConfig.after_create) {
      try {
        await runHook(
          this.hooksConfig.after_create,
          workspacePath,
          this.hooksConfig.timeout_ms,
          this.hookEnv,
        );
      } catch (err) {
        // after_create failure is fatal — remove the partially created directory
        await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
    }

    return { path: workspacePath, workspace_key: workspaceKey, created_now: createdNow };
  }

  /**
   * Remove the workspace directory for an issue identifier.
   * Runs before_remove hook first (failure is logged and ignored).
   */
  async removeWorkspace(identifier: string): Promise<void> {
    const workspacePath = getWorkspacePath(this.workspaceConfig.root, identifier);

    assertPathContained(this.workspaceConfig.root, workspacePath);

    // Check if the directory exists before running the hook
    let exists = false;
    try {
      const s = await stat(workspacePath);
      exists = s.isDirectory();
    } catch {
      // Does not exist — nothing to do
      return;
    }

    if (!exists) return;

    if (this.hooksConfig.before_remove) {
      try {
        await runHook(
          this.hooksConfig.before_remove,
          workspacePath,
          this.hooksConfig.timeout_ms,
          this.hookEnv,
        );
      } catch {
        // before_remove failure is logged and ignored; cleanup proceeds
      }
    }

    await rm(workspacePath, { recursive: true, force: true });
  }

  /**
   * Run the before_run hook in the workspace directory.
   * Throws on failure — fatal to the current run attempt.
   */
  async runBeforeHook(workspacePath: string): Promise<void> {
    if (!this.hooksConfig.before_run) return;
    await runHook(this.hooksConfig.before_run, workspacePath, this.hooksConfig.timeout_ms, this.hookEnv);
  }

  /**
   * Run the after_run hook in the workspace directory.
   * Failure is swallowed — never propagated to caller.
   */
  async runAfterHook(workspacePath: string): Promise<void> {
    if (!this.hooksConfig.after_run) return;
    try {
      await runHook(this.hooksConfig.after_run, workspacePath, this.hooksConfig.timeout_ms, this.hookEnv);
    } catch {
      // Intentionally swallowed — after_run failures must not affect orchestration
    }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  // Avoid instanceof Error — fails across Jest ESM VM module boundaries.
  // A structural check on the code property is sufficient and more robust.
  return typeof err === "object" && err !== null && "code" in err;
}
