import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import path from "path";
import os from "os";
import {
  readWorkspaceFile,
  writeWorkspaceFile,
  listWorkspaceDir,
} from "../tools/fileOps.js";
import { WorkspaceError } from "../../types/errors.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "fileops-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("readWorkspaceFile", () => {
  it("reads a file relative to workspace root", async () => {
    await writeFile(path.join(tmpDir, "hello.txt"), "hello world");
    const content = await readWorkspaceFile("hello.txt", tmpDir);
    expect(content).toBe("hello world");
  });

  it("reads a file using an absolute path within workspace", async () => {
    await writeFile(path.join(tmpDir, "abs.txt"), "absolute");
    const content = await readWorkspaceFile(path.join(tmpDir, "abs.txt"), tmpDir);
    expect(content).toBe("absolute");
  });

  it("throws WorkspaceError for path escaping workspace (..)", async () => {
    await expect(readWorkspaceFile("../escape.txt", tmpDir)).rejects.toMatchObject({
      code: "workspace_path_invalid",
    });
  });

  it("throws WorkspaceError for absolute path outside workspace", async () => {
    await expect(readWorkspaceFile("/etc/passwd", tmpDir)).rejects.toMatchObject({
      code: "workspace_path_invalid",
    });
  });
});

describe("writeWorkspaceFile", () => {
  it("writes a new file relative to workspace root", async () => {
    await writeWorkspaceFile("output.txt", "written content", tmpDir);
    const content = await readWorkspaceFile("output.txt", tmpDir);
    expect(content).toBe("written content");
  });

  it("overwrites an existing file", async () => {
    await writeWorkspaceFile("file.txt", "first", tmpDir);
    await writeWorkspaceFile("file.txt", "second", tmpDir);
    const content = await readWorkspaceFile("file.txt", tmpDir);
    expect(content).toBe("second");
  });

  it("throws WorkspaceError for path escaping workspace", async () => {
    await expect(writeWorkspaceFile("../../evil.txt", "x", tmpDir)).rejects.toMatchObject({
      code: "workspace_path_invalid",
    });
  });
});

describe("listWorkspaceDir", () => {
  it("lists files and directories in workspace root", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "");
    await mkdir(path.join(tmpDir, "subdir"));
    const entries = await listWorkspaceDir(".", tmpDir);
    const names = entries.map((e) => e.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("subdir");
  });

  it("distinguishes files from directories", async () => {
    await writeFile(path.join(tmpDir, "f.txt"), "");
    await mkdir(path.join(tmpDir, "d"));
    const entries = await listWorkspaceDir(".", tmpDir);
    const file = entries.find((e) => e.name === "f.txt");
    const dir = entries.find((e) => e.name === "d");
    expect(file?.type).toBe("file");
    expect(dir?.type).toBe("directory");
  });

  it("lists a subdirectory", async () => {
    await mkdir(path.join(tmpDir, "sub"));
    await writeFile(path.join(tmpDir, "sub", "inner.txt"), "");
    const entries = await listWorkspaceDir("sub", tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("inner.txt");
  });

  it("throws WorkspaceError for path escaping workspace", async () => {
    await expect(listWorkspaceDir("../../etc", tmpDir)).rejects.toMatchObject({
      code: "workspace_path_invalid",
    });
  });
});
