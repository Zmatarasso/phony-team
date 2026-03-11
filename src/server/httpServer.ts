import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { OrchestratorRuntimeState, RunningEntry, RetryEntry } from "../types/domain.js";
import type { TokenTracker, DayRecord } from "../logging/tokenTracker.js";
import { createApp as createWebsiteApp } from "../website/websiteServer.js";

// --- Response shape helpers ---

interface ErrorEnvelope {
  error: { code: string; message: string };
}

function errorJson(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } };
}

// --- State serialization ---

function serializeRunning(entry: RunningEntry): Record<string, unknown> {
  const elapsedMs = Date.now() - entry.started_at.getTime();
  return {
    identifier: entry.identifier,
    issue_id: entry.issue.id,
    state: entry.issue.state,
    turn_count: entry.session.turn_count ?? 0,
    input_tokens: entry.session.codex_input_tokens ?? 0,
    output_tokens: entry.session.codex_output_tokens ?? 0,
    last_event: entry.session.last_codex_event ?? null,
    last_event_at: entry.session.last_codex_timestamp?.toISOString() ?? null,
    elapsed_ms: elapsedMs,
    retry_attempt: entry.retry_attempt,
  };
}

function serializeRetry(entry: RetryEntry): Record<string, unknown> {
  return {
    identifier: entry.identifier,
    issue_id: entry.issue_id,
    attempt: entry.attempt,
    due_at: new Date(entry.due_at_ms).toISOString(),
    error: entry.error,
  };
}

function buildStateResponse(state: Readonly<OrchestratorRuntimeState>): Record<string, unknown> {
  const running = Array.from(state.running.values()).map(serializeRunning);
  const retrying = Array.from(state.retry_attempts.values()).map(serializeRetry);
  return {
    generated_at: new Date().toISOString(),
    counts: {
      running: running.length,
      retrying: retrying.length,
    },
    running,
    retrying,
    codex_totals: {
      input_tokens: state.codex_totals.input_tokens,
      output_tokens: state.codex_totals.output_tokens,
      total_tokens: state.codex_totals.total_tokens,
      seconds_running: Math.round(state.codex_totals.seconds_running),
    },
    rate_limits: state.codex_rate_limits,
    jira_api_calls: state.jira_api_calls,
  };
}

// --- Dashboard HTML ---

function renderDailyUsage(usage: Record<string, DayRecord>): string {
  const days = Object.keys(usage).sort().reverse();
  if (days.length === 0) return '<p class="empty">No token usage recorded yet.</p>';
  const rows = days
    .map((d) => {
      const r = usage[d]!;
      return `<tr>
        <td>${esc(d)}</td>
        <td>${r.input_tokens.toLocaleString()}</td>
        <td>${r.output_tokens.toLocaleString()}</td>
        <td>${r.total_tokens.toLocaleString()}</td>
      </tr>`;
    })
    .join("\n");
  return `<table>
  <thead><tr><th>Date</th><th>Input</th><th>Output</th><th>Total</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function renderDashboard(state: Readonly<OrchestratorRuntimeState>, dailyUsage: Record<string, DayRecord>): string {
  const running = Array.from(state.running.values());
  const retrying = Array.from(state.retry_attempts.values());

  const runningRows = running
    .map((e) => {
      const elapsed = Math.round((Date.now() - e.started_at.getTime()) / 1000);
      return `<tr>
        <td>${esc(e.identifier)}</td>
        <td>${esc(e.issue.state)}</td>
        <td>${e.session.turn_count ?? 0}</td>
        <td>${(e.session.codex_input_tokens ?? 0) + (e.session.codex_output_tokens ?? 0)}</td>
        <td>${esc(e.session.last_codex_event ?? "-")}</td>
        <td>${elapsed}s</td>
      </tr>`;
    })
    .join("\n");

  const retryRows = retrying
    .map((e) => {
      const dueIn = Math.max(0, Math.round((e.due_at_ms - Date.now()) / 1000));
      return `<tr>
        <td>${esc(e.identifier)}</td>
        <td>${e.attempt}</td>
        <td>${dueIn}s</td>
        <td>${esc(e.error ?? "-")}</td>
      </tr>`;
    })
    .join("\n");

  const totals = state.codex_totals;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="10">
  <title>Symphony Dashboard</title>
  <style>
    body { font-family: monospace; background: #0d1117; color: #c9d1d9; margin: 2rem; }
    h1 { color: #58a6ff; }
    h2 { color: #8b949e; border-bottom: 1px solid #30363d; padding-bottom: 0.5rem; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
    th { text-align: left; color: #8b949e; border-bottom: 1px solid #30363d; padding: 0.4rem 0.8rem; }
    td { padding: 0.4rem 0.8rem; border-bottom: 1px solid #161b22; }
    tr:hover td { background: #161b22; }
    .stat { display: inline-block; margin-right: 2rem; }
    .stat-value { font-size: 1.4rem; color: #58a6ff; }
    .empty { color: #6e7681; font-style: italic; }
    .nav-link { color: #58a6ff; text-decoration: none; font-size: 1.1rem; }
    .nav-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Symphony Dashboard</h1>
  <p>Last refresh: ${new Date().toISOString()}</p>
  <p><a class="nav-link" href="/website">&#127760; View Website</a></p>

  <h2>Totals</h2>
  <div>
    <span class="stat"><span class="stat-value">${running.length}</span> running</span>
    <span class="stat"><span class="stat-value">${retrying.length}</span> retrying</span>
    <span class="stat"><span class="stat-value">${totals.input_tokens + totals.output_tokens}</span> total tokens</span>
    <span class="stat"><span class="stat-value">${Math.round(totals.seconds_running)}s</span> agent time</span>
    <span class="stat"><span class="stat-value">${state.jira_api_calls}</span> Jira API calls</span>
  </div>

  <h2>Running Sessions</h2>
  ${running.length === 0
    ? '<p class="empty">No active sessions.</p>'
    : `<table>
    <thead><tr><th>Issue</th><th>State</th><th>Turns</th><th>Tokens</th><th>Last Event</th><th>Elapsed</th></tr></thead>
    <tbody>${runningRows}</tbody>
  </table>`}

  <h2>Retry Queue</h2>
  ${retrying.length === 0
    ? '<p class="empty">No pending retries.</p>'
    : `<table>
    <thead><tr><th>Issue</th><th>Attempt</th><th>Due In</th><th>Last Error</th></tr></thead>
    <tbody>${retryRows}</tbody>
  </table>`}

  <h2>Token Usage by Day</h2>
  ${renderDailyUsage(dailyUsage)}
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Server factory ---

export interface SymphonyServer {
  readonly port: number;
  stop(): Promise<void>;
}

export async function startServer(orchestrator: Orchestrator, port: number, tokenTracker: TokenTracker): Promise<SymphonyServer> {
  const app = express();
  app.use(express.json());

  // GET /api/v1/state
  app.get("/api/v1/state", (_req: Request, res: Response) => {
    res.json(buildStateResponse(orchestrator.getState()));
  });

  // GET /api/v1/:identifier
  app.get("/api/v1/:identifier", (req: Request, res: Response) => {
    const { identifier } = req.params;
    const state = orchestrator.getState();
    const entry = Array.from(state.running.values()).find(
      (e) => e.identifier === identifier,
    );
    const retry = state.retry_attempts.get(
      Array.from(state.running.entries()).find(([, e]) => e.identifier === identifier)?.[0] ?? "",
    ) ?? Array.from(state.retry_attempts.values()).find((e) => e.identifier === identifier);

    if (!entry && !retry) {
      return res.status(404).json(errorJson("not_found", `Issue ${identifier} not found`));
    }

    return res.json({
      identifier,
      running: entry ? serializeRunning(entry) : null,
      retrying: retry ? serializeRetry(retry) : null,
    });
  });

  // POST /api/v1/refresh
  app.post("/api/v1/refresh", (req: Request, res: Response) => {
    orchestrator.triggerPoll();
    res.status(202).json({
      queued: true,
      coalesced: false,
      requested_at: new Date().toISOString(),
      operations: ["poll", "reconcile"],
    });
  });

  // Mount the website app at /website
  app.use("/website", createWebsiteApp());

  // GET / — dashboard
  app.get("/", (_req: Request, res: Response) => {
    void (async () => {
      const dailyUsage = await tokenTracker.getUsage().catch(() => ({}));
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderDashboard(orchestrator.getState(), dailyUsage));
    })();
  });

  // 404 for undefined routes
  app.use((_req: Request, res: Response) => {
    res.status(404).json(errorJson("not_found", "Route not found"));
  });

  // Method not allowed — catch wrong-method on defined paths
  // Express returns 404 by default for unmatched methods; this middleware runs after all routes
  // to return 405 for paths that exist but with the wrong method.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json(errorJson("internal_error", "Internal server error"));
  });

  const server: Server = app.listen(port, "127.0.0.1");

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const actualPort = (server.address() as AddressInfo).port;

  return {
    port: actualPort,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
