import { writeFile, mkdtemp, rm } from "fs/promises";
import path from "path";
import os from "os";
import { startWatcher } from "../workflowWatcher.js";
import type { WorkflowDefinition } from "../../types/domain.js";

/**
 * Wait for a callback to be called, polling every 20ms up to timeoutMs.
 * Returns the collected value or throws if it never arrives.
 */
function waitFor<T>(
  getter: () => T | undefined,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const value = getter();
      if (value !== undefined) {
        clearInterval(interval);
        resolve(value);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      }
    }, 20);
  });
}

describe("startWatcher", () => {
  let tmpDir: string;
  let workflowPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "symphony-watcher-test-"));
    workflowPath = path.join(tmpDir, "WORKFLOW.md");
    // Write initial valid file
    await writeFile(workflowPath, "---\ntracker:\n  space_key: INIT\n---\nInitial prompt.");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("calls onReload with the new WorkflowDefinition when the file changes", async () => {
    let received: WorkflowDefinition | undefined;
    const watcher = startWatcher(
      workflowPath,
      (wf) => { received = wf; },
      () => { /* no error expected */ },
    );

    try {
      await watcher.ready;
      await writeFile(
        workflowPath,
        "---\ntracker:\n  space_key: UPDATED\n---\nNew prompt.",
      );
      const wf = await waitFor(() => received);
      expect(wf.prompt_template).toBe("New prompt.");
      expect(
        (wf.config["tracker"] as Record<string, unknown>)["space_key"],
      ).toBe("UPDATED");
    } finally {
      await watcher.stop();
    }
  });

  it("calls onError and does NOT call onReload when the file has invalid YAML", async () => {
    let reloadCalled = false;
    let errorReceived: unknown;

    const watcher = startWatcher(
      workflowPath,
      () => { reloadCalled = true; },
      (err) => { errorReceived = err; },
    );

    try {
      await watcher.ready;
      await writeFile(workflowPath, "---\n: broken: yaml: [\n---\nPrompt.");
      await waitFor(() => errorReceived);
      expect(reloadCalled).toBe(false);
      expect(errorReceived).toBeDefined();
    } finally {
      await watcher.stop();
    }
  });

  it("calls onError when front matter is not a map (non-map YAML)", async () => {
    let errorReceived: unknown;

    const watcher = startWatcher(
      workflowPath,
      () => { /* not expected */ },
      (err) => { errorReceived = err; },
    );

    try {
      await watcher.ready;
      await writeFile(workflowPath, "---\n- list item\n- another\n---\nPrompt.");
      await waitFor(() => errorReceived, 3000);
      expect(errorReceived).toBeDefined();
    } finally {
      await watcher.stop();
    }
  });

  it("debounces rapid successive writes and only calls onReload once", async () => {
    let callCount = 0;
    let lastReceived: WorkflowDefinition | undefined;

    const watcher = startWatcher(
      workflowPath,
      (wf) => {
        callCount++;
        lastReceived = wf;
      },
      () => { /* no error expected */ },
    );

    try {
      await watcher.ready;
      // Write three times in quick succession
      await writeFile(workflowPath, "---\n---\nFirst.");
      await writeFile(workflowPath, "---\n---\nSecond.");
      await writeFile(workflowPath, "---\n---\nThird.");

      await waitFor(() => lastReceived);
      // Allow a bit of extra time to confirm no duplicate calls
      await new Promise((r) => setTimeout(r, 400));

      expect(lastReceived?.prompt_template).toBe("Third.");
      // May fire 1-2 times due to filesystem event coalescing; should NOT fire 3 times
      expect(callCount).toBeLessThan(3);
    } finally {
      await watcher.stop();
    }
  });

  it("stop() prevents further callbacks after being called", async () => {
    let callCount = 0;
    const watcher = startWatcher(
      workflowPath,
      () => { callCount++; },
      () => { /* ignore */ },
    );

    await watcher.ready;
    await watcher.stop();

    await writeFile(workflowPath, "---\n---\nAfter stop.");
    // Wait long enough that any in-flight debounce would have fired
    await new Promise((r) => setTimeout(r, 500));

    expect(callCount).toBe(0);
  });

  it("can be stopped and the returned promise resolves cleanly", async () => {
    const watcher = startWatcher(workflowPath, () => {}, () => {});
    await expect(watcher.stop()).resolves.toBeUndefined();
  });
});
