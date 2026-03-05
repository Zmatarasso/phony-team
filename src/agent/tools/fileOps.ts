import { readFile, writeFile, readdir } from "fs/promises";
import path from "path";
import { WorkspaceError } from "../../types/errors.js";

export interface DirEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "other";
}

/**
 * Resolve filePath relative to workspacePath and verify it stays within the workspace.
 * Absolute paths are accepted but must still resolve inside workspacePath.
 */
function resolveContained(filePath: string, workspacePath: string): string {
  const root = path.normalize(workspacePath);
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.normalize(path.join(root, filePath));

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new WorkspaceError(
      "workspace_path_invalid",
      `Path escapes workspace boundary: ${filePath}`,
    );
  }
  return resolved;
}

export async function readWorkspaceFile(filePath: string, workspacePath: string): Promise<string> {
  const resolved = resolveContained(filePath, workspacePath);
  return readFile(resolved, "utf-8");
}

export async function writeWorkspaceFile(
  filePath: string,
  content: string,
  workspacePath: string,
): Promise<void> {
  const resolved = resolveContained(filePath, workspacePath);
  await writeFile(resolved, content, "utf-8");
}

export async function listWorkspaceDir(
  dirPath: string,
  workspacePath: string,
): Promise<DirEntry[]> {
  const resolved = resolveContained(dirPath, workspacePath);
  const entries = await readdir(resolved, { withFileTypes: true });
  return entries.map((e) => ({
    name: e.name,
    type: e.isDirectory() ? "directory" : e.isFile() ? "file" : "other",
  }));
}
