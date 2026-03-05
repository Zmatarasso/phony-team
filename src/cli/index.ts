#!/usr/bin/env node
import "dotenv/config";
import process from "process";
import path from "path";
import { fileURLToPath } from "url";
import { loadWorkflow } from "../config/workflowLoader.js";
import { buildConfig } from "../config/configLayer.js";
import { validateDispatchConfig } from "../config/validation.js";
import { startWatcher } from "../config/workflowWatcher.js";
import { createLogger } from "../logging/logger.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { startServer, type SymphonyServer } from "../server/httpServer.js";

// --- Argument parsing ---

export interface CliArgs {
  workflowPath: string;
  port: number | null;
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // strip "node" and script path
  let workflowPath = "./WORKFLOW.md";
  let port: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && i + 1 < args.length) {
      const raw = args[++i];
      const parsed = parseInt(raw ?? "", 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
        process.stderr.write(`Error: --port must be a valid port number, got: ${raw}\n`);
        process.exit(1);
      }
      port = parsed;
    } else if (arg && !arg.startsWith("-")) {
      workflowPath = arg;
    }
  }

  return { workflowPath, port };
}

// --- Main ---

async function main(): Promise<void> {
  const { workflowPath, port: cliPort } = parseArgs(process.argv);
  const resolvedWorkflowPath = path.resolve(workflowPath);

  // 1. Load and validate workflow
  let workflow;
  try {
    workflow = await loadWorkflow(resolvedWorkflowPath);
  } catch (err) {
    process.stderr.write(`Error: Failed to load workflow: ${String(err)}\n`);
    process.exit(1);
  }

  let config;
  try {
    config = buildConfig(workflow.config);
  } catch (err) {
    process.stderr.write(`Error: Invalid configuration: ${String(err)}\n`);
    process.exit(1);
  }

  const validation = validateDispatchConfig(config);
  if (!validation.ok) {
    for (const msg of validation.errors) {
      process.stderr.write(`Error: ${msg}\n`);
    }
    process.exit(1);
  }

  const anthropicApiKey = process.env["ANTHROPIC_API_KEY"] ?? "";
  if (config.agent.backend !== "grok" && !anthropicApiKey) {
    process.stderr.write("Error: ANTHROPIC_API_KEY environment variable is required\n");
    process.exit(1);
  }

  const xaiApiKey = process.env["XAI_API_KEY"] ?? config.grok.api_key;

  // 2. Initialize logger
  const logFile = process.env["SYMPHONY_LOG_FILE"] ?? "./symphony.log";
  const summaryFile = process.env["SYMPHONY_SUMMARY_LOG_FILE"] ?? "./symphony-summary.log";
  const logger = createLogger({ logFile, summaryFile });

  // 3. Start workflow watcher
  const watcher = startWatcher(
    resolvedWorkflowPath,
    (newWorkflow) => {
      logger.info("Workflow reloaded");
      orchestrator.updateWorkflow(newWorkflow);
    },
    (err) => {
      logger.warn("Workflow reload failed", { error: String(err) });
    },
  );
  await watcher.ready;

  // 4–5. Create and start orchestrator
  const orchestrator = new Orchestrator({
    config,
    workflow,
    logger,
    anthropicApiKey,
    xaiApiKey,
  });

  await orchestrator.start();

  // 6. Start HTTP server if port is configured
  const serverPort = cliPort ?? config.server.port;
  let server: SymphonyServer | null = null;
  if (serverPort !== undefined) {
    try {
      server = await startServer(orchestrator, serverPort);
      logger.info(`HTTP server listening on http://127.0.0.1:${server.port}`);
    } catch (err) {
      logger.warn("Failed to start HTTP server", { error: String(err) });
    }
  }

  // 7. Log startup summary
  logger.info("Symphony started", {
    workflow: resolvedWorkflowPath,
    space_key: config.tracker.space_key,
    max_concurrent_agents: config.agent.max_concurrent_agents,
    poll_interval_ms: config.polling.interval_ms,
  });

  // --- Shutdown ---
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);

    await watcher.stop();

    const gracefulMs = 30_000;
    await orchestrator.stop(gracefulMs);

    if (server) {
      await server.stop().catch((stopErr: unknown) => {
        logger.warn("Error stopping HTTP server", { error: String(stopErr) });
      });
    }

    logger.info("Symphony stopped.");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Only run when invoked directly (not when imported by tests or other modules)
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((err: unknown) => {
    process.stderr.write(`Fatal error: ${String(err)}\n`);
    process.exit(1);
  });
}
