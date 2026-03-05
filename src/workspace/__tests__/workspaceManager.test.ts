import { mkdtemp, mkdir, writeFile, stat, rm } from "fs/promises";
import path from "path";
import os from "os";
import {
  WorkspaceManager,
  sanitizeIdentifier,
  getWorkspacePath,
  assertPathContained,
} from "../workspaceManager.js";
import { WorkspaceError } from "../../types/errors.js";
import type { WorkspaceConfig, HooksConfig } from "../../types/config.js";

function makeConfig(
  root: string,
  hooks: Partial<HooksConfig> = {},
): { workspaceConfig: WorkspaceConfig; hooksConfig: HooksConfig } {
  return {
    workspaceConfig: { root },
    hooksConfig: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 5_000,
      ...hooks,
    },
  };
}

describe("sanitizeIdentifier", () => {
  it("preserves allowed characters [A-Za-z0-9._-]", () => {
    expect(sanitizeIdentifier("PHONY-42")).toBe("PHONY-42");
    expect(sanitizeIdentifier("abc.def_123-XYZ")).toBe("abc.def_123-XYZ");
  });

  it("replaces disallowed characters with underscore", () => {
    expect(sanitizeIdentifier("PROJ/42")).toBe("PROJ_42");
    expect(sanitizeIdentifier("a b:c")).toBe("a_b_c");
    expect(sanitizeIdentifier("../../etc")).toBe(".._.._etc");
  });

  it("replaces path separators (path traversal prevention)", () => {
    expect(sanitizeIdentifier("../secret")).toBe(".._secret");
  });
});

describe("assertPathContained", () => {
  it("passes when path is directly under root", () => {
    expect(() => assertPathContained("/tmp/root", "/tmp/root/PHONY-1")).not.toThrow();
  });

  it("throws when path equals root (not a subdirectory)", () => {
    expect(() => assertPathContained("/tmp/root", "/tmp/root")).toThrow(WorkspaceError);
  });

  it("throws when path is outside root", () => {
    expect(() => assertPathContained("/tmp/root", "/tmp/other")).toThrow(WorkspaceError);
  });

  it("throws on path traversal attempt", () => {
    expect(() => assertPathContained("/tmp/root", "/tmp/root/../secret")).toThrow(WorkspaceError);
  });

  it("does not confuse /tmp/root with /tmp/rootsuffix", () => {
    expect(() => assertPathContained("/tmp/root", "/tmp/rootsuffix/issue")).toThrow(WorkspaceError);
  });
});

describe("WorkspaceManager.ensureWorkspace", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-ws-test-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("creates the workspace directory when it does not exist", async () => {
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot);
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    const info = await mgr.ensureWorkspace("PHONY-1");
    expect(info.created_now).toBe(true);
    expect(info.workspace_key).toBe("PHONY-1");
    const s = await stat(info.path);
    expect(s.isDirectory()).toBe(true);
  });

  it("reuses existing workspace and sets created_now=false", async () => {
    const wsPath = path.join(tmpRoot, "PHONY-1");
    await mkdir(wsPath);
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot);
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    const info = await mgr.ensureWorkspace("PHONY-1");
    expect(info.created_now).toBe(false);
  });

  it("runs after_create hook only on new directory creation", async () => {
    const markerFile = path.join(tmpRoot, "hook-ran");
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot, {
      after_create: `touch "${markerFile}"`,
    });
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);

    // First call: new directory — hook should run
    await mgr.ensureWorkspace("PHONY-2");
    await expect(stat(markerFile)).resolves.toBeDefined();

    // Remove marker and call again: existing directory — hook should NOT run
    await rm(markerFile);
    await mgr.ensureWorkspace("PHONY-2");
    await expect(stat(markerFile)).rejects.toThrow(); // marker was not recreated
  });

  it("removes partially created directory when after_create hook fails", async () => {
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot, {
      after_create: "exit 1",
    });
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    await expect(mgr.ensureWorkspace("PHONY-3")).rejects.toThrow(WorkspaceError);
    // Directory should have been cleaned up
    await expect(stat(path.join(tmpRoot, "PHONY-3"))).rejects.toThrow();
  });

  it("sanitizes the identifier to derive the workspace key and path", async () => {
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot);
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    const info = await mgr.ensureWorkspace("PROJ/42");
    expect(info.workspace_key).toBe("PROJ_42");
    expect(info.path).toBe(path.join(tmpRoot, "PROJ_42"));
  });
});

describe("WorkspaceManager.removeWorkspace", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-ws-rm-test-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("removes an existing workspace directory", async () => {
    const wsPath = path.join(tmpRoot, "PHONY-10");
    await mkdir(wsPath);
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot);
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    await mgr.removeWorkspace("PHONY-10");
    await expect(stat(wsPath)).rejects.toThrow();
  });

  it("does nothing when workspace does not exist", async () => {
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot);
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    await expect(mgr.removeWorkspace("PHONY-NONEXISTENT")).resolves.toBeUndefined();
  });

  it("runs before_remove hook before deletion", async () => {
    const wsPath = path.join(tmpRoot, "PHONY-11");
    await mkdir(wsPath);
    const markerFile = path.join(tmpRoot, "before-remove-ran");
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot, {
      before_remove: `touch "${markerFile}"`,
    });
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    await mgr.removeWorkspace("PHONY-11");
    // Directory is gone but marker was created before removal
    await expect(stat(markerFile)).resolves.toBeDefined();
    await expect(stat(wsPath)).rejects.toThrow();
  });

  it("proceeds with removal even when before_remove hook fails", async () => {
    const wsPath = path.join(tmpRoot, "PHONY-12");
    await mkdir(wsPath);
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot, {
      before_remove: "exit 1",
    });
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    // Should not throw, and directory should be gone
    await expect(mgr.removeWorkspace("PHONY-12")).resolves.toBeUndefined();
    await expect(stat(wsPath)).rejects.toThrow();
  });
});

describe("WorkspaceManager.runBeforeHook", () => {
  let tmpRoot: string;
  let wsPath: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-hook-test-"));
    wsPath = path.join(tmpRoot, "PHONY-20");
    await mkdir(wsPath);
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("runs before_run hook successfully", async () => {
    const markerFile = path.join(wsPath, "before-run-marker");
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot, {
      before_run: `touch "${markerFile}"`,
    });
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    await mgr.runBeforeHook(wsPath);
    await expect(stat(markerFile)).resolves.toBeDefined();
  });

  it("throws when before_run hook fails — fatal to attempt", async () => {
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot, {
      before_run: "exit 1",
    });
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    await expect(mgr.runBeforeHook(wsPath)).rejects.toThrow(WorkspaceError);
  });

  it("is a no-op when before_run is null", async () => {
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot);
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    await expect(mgr.runBeforeHook(wsPath)).resolves.toBeUndefined();
  });
});

describe("WorkspaceManager.runAfterHook", () => {
  let tmpRoot: string;
  let wsPath: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-after-test-"));
    wsPath = path.join(tmpRoot, "PHONY-30");
    await mkdir(wsPath);
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("runs after_run hook successfully", async () => {
    const markerFile = path.join(wsPath, "after-run-marker");
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot, {
      after_run: `touch "${markerFile}"`,
    });
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    await mgr.runAfterHook(wsPath);
    await expect(stat(markerFile)).resolves.toBeDefined();
  });

  it("does NOT throw when after_run hook fails — swallowed", async () => {
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot, {
      after_run: "exit 1",
    });
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    await expect(mgr.runAfterHook(wsPath)).resolves.toBeUndefined();
  });

  it("is a no-op when after_run is null", async () => {
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot);
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    await expect(mgr.runAfterHook(wsPath)).resolves.toBeUndefined();
  });
});

describe("hook timeout", () => {
  let tmpRoot: string;
  let wsPath: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-timeout-test-"));
    wsPath = path.join(tmpRoot, "PHONY-99");
    await mkdir(wsPath);
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("times out and throws WorkspaceError when hook exceeds timeout_ms", async () => {
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot, {
      before_run: "sleep 10",
      timeout_ms: 200,
    });
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    await expect(mgr.runBeforeHook(wsPath)).rejects.toMatchObject({
      code: "workspace_hook_timeout",
    });
  }, 3_000);
});

describe("workspace — non-directory path handling", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-file-test-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("throws WorkspaceError when a file exists at the workspace path", async () => {
    const wsPath = path.join(tmpRoot, "PHONY-50");
    await writeFile(wsPath, "not a directory");
    const { workspaceConfig, hooksConfig } = makeConfig(tmpRoot);
    const mgr = new WorkspaceManager(workspaceConfig, hooksConfig);
    await expect(mgr.ensureWorkspace("PHONY-50")).rejects.toMatchObject({
      code: "workspace_creation_failed",
    });
  });
});
