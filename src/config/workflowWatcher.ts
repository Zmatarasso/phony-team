import { watch, type FSWatcher } from "chokidar";
import { loadWorkflow } from "./workflowLoader.js";
import type { WorkflowDefinition } from "../types/domain.js";

export interface WatcherDisposable {
  stop(): Promise<void>;
}

export type ReloadCallback = (workflow: WorkflowDefinition) => void;
export type ErrorCallback = (err: unknown) => void;

const DEBOUNCE_MS = 200;

/**
 * Watches a WORKFLOW.md file for changes. On a valid change, calls onReload
 * with the new WorkflowDefinition. On an invalid change (parse error, missing
 * file), calls onError and keeps the last good config untouched.
 *
 * Returns a disposable that stops the watcher cleanly.
 */
export function startWatcher(
  filePath: string,
  onReload: ReloadCallback,
  onError: ErrorCallback,
): WatcherDisposable {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher: FSWatcher = watch(filePath, {
    persistent: false,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  const handleChange = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      loadWorkflow(filePath)
        .then((workflow) => {
          onReload(workflow);
        })
        .catch((err: unknown) => {
          onError(err);
        });
    }, DEBOUNCE_MS);
  };

  watcher.on("change", handleChange);
  watcher.on("add", handleChange);

  return {
    stop: async (): Promise<void> => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      await watcher.close();
    },
  };
}
