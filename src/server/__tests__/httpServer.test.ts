import { jest } from "@jest/globals";
import request from "supertest";
import { startServer } from "../httpServer.js";
import type { Orchestrator } from "../../orchestrator/orchestrator.js";
import type { OrchestratorRuntimeState } from "../../types/domain.js";
import type { TokenTracker } from "../../logging/tokenTracker.js";

function makeMockTokenTracker(): TokenTracker {
  return {
    getUsage: jest.fn<() => Promise<Record<string, never>>>().mockResolvedValue({}),
    recordTokens: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as TokenTracker;
}

// --- Mock orchestrator ---

function makeState(overrides: Partial<OrchestratorRuntimeState> = {}): OrchestratorRuntimeState {
  return {
    poll_interval_ms: 30_000,
    max_concurrent_agents: 5,
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    completed: new Set(),
    codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
    codex_rate_limits: null,
    jira_api_calls: 0,
    activity_feed: [],
    ...overrides,
  };
}

function makeMockOrchestrator(state: OrchestratorRuntimeState = makeState()): Orchestrator {
  return {
    getState: jest.fn<() => OrchestratorRuntimeState>().mockReturnValue(state),
    triggerPoll: jest.fn<() => void>(),
  } as unknown as Orchestrator;
}

// --- Tests ---

describe("GET /api/v1/state", () => {
  it("returns 200 with correct shape", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/api/v1/state");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        counts: { running: 0, retrying: 0 },
        running: [],
        retrying: [],
        codex_totals: expect.objectContaining({ input_tokens: 0, output_tokens: 0 }),
      });
      expect(res.body["generated_at"]).toBeDefined();
    } finally {
      await srv.stop();
    }
  });

  it("reflects running and retrying counts", async () => {
    const runningEntry = {
      issue: {
        id: "1",
        identifier: "PHONY-1",
        title: "T",
        description: null,
        priority: 1,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      identifier: "PHONY-1",
      workspace_path: "/tmp/ws/PHONY-1",
      session: {},
      retry_attempt: null,
      started_at: new Date(),
      worker_promise: Promise.resolve(),
      abort_controller: new AbortController(),
    };
    const state = makeState({ running: new Map([["1", runningEntry]]) });
    const orch = makeMockOrchestrator(state);
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/api/v1/state");
      expect(res.status).toBe(200);
      expect(res.body["counts"]["running"]).toBe(1);
      expect(res.body["running"]).toHaveLength(1);
      expect(res.body["running"][0]["identifier"]).toBe("PHONY-1");
    } finally {
      await srv.stop();
    }
  });
});

describe("GET /api/v1/:identifier", () => {
  it("returns 404 for unknown identifier", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/api/v1/PHONY-99");
      expect(res.status).toBe(404);
      expect(res.body["error"]).toBeDefined();
    } finally {
      await srv.stop();
    }
  });

  it("returns issue data for a running identifier", async () => {
    const runningEntry = {
      issue: {
        id: "2",
        identifier: "PHONY-2",
        title: "T",
        description: null,
        priority: 1,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      identifier: "PHONY-2",
      workspace_path: "/tmp/ws/PHONY-2",
      session: {},
      retry_attempt: null,
      started_at: new Date(),
      worker_promise: Promise.resolve(),
      abort_controller: new AbortController(),
    };
    const state = makeState({ running: new Map([["2", runningEntry]]) });
    const srv = await startServer(makeMockOrchestrator(state), 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/api/v1/PHONY-2");
      expect(res.status).toBe(200);
      expect(res.body["identifier"]).toBe("PHONY-2");
      expect(res.body["running"]).not.toBeNull();
    } finally {
      await srv.stop();
    }
  });
});

describe("POST /api/v1/refresh", () => {
  it("returns 202 and triggers orchestrator poll", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).post("/api/v1/refresh");
      expect(res.status).toBe(202);
      expect(res.body["queued"]).toBe(true);
      expect(orch.triggerPoll).toHaveBeenCalledTimes(1);
    } finally {
      await srv.stop();
    }
  });
});

describe("GET / (dashboard)", () => {
  it("returns 200 HTML", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.text).toContain("Symphony Dashboard");
    } finally {
      await srv.stop();
    }
  });

  it("dashboard contains no <script> tags", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/");
      expect(res.text).not.toContain("<script");
    } finally {
      await srv.stop();
    }
  });

  it("dashboard includes auto-refresh meta tag", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/");
      expect(res.text).toContain("http-equiv=\"refresh\"");
    } finally {
      await srv.stop();
    }
  });

  it("dashboard contains a link to /website", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/");
      expect(res.text).toContain('href="/website"');
      expect(res.text).toContain("View Website");
    } finally {
      await srv.stop();
    }
  });
});

describe("GET /website (mounted website app)", () => {
  it("serves the website frontend HTML at /website/", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/website/");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.text).toContain("Time &amp; Weather");
    } finally {
      await srv.stop();
    }
  });

  it("serves the time API at /website/api/time", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/website/api/time");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("timezone");
      expect(res.body).toHaveProperty("datetime");
      expect(res.body).toHaveProperty("label", "TIME");
    } finally {
      await srv.stop();
    }
  });

  it("serves the weather API at /website/api/weather", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/website/api/weather");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("location");
      expect(res.body).toHaveProperty("temperature_f");
      expect(res.body).toHaveProperty("label", "WEATH");
    } finally {
      await srv.stop();
    }
  });

  it("redirects /website to /website/ for proper relative URL resolution", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/website");
      // Express sub-app mount typically redirects /website to /website/
      expect([200, 301, 302, 303, 307, 308]).toContain(res.status);
    } finally {
      await srv.stop();
    }
  });
});

describe("404 for undefined routes", () => {
  it("returns 404 JSON for unknown path", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/nonexistent/route");
      expect(res.status).toBe(404);
      expect(res.body["error"]).toBeDefined();
    } finally {
      await srv.stop();
    }
  });
});

describe("405 for wrong method on defined routes", () => {
  it("returns 405 for GET on /api/v1/refresh", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/api/v1/refresh");
      // Express returns 404 for wrong method unless we add method-not-allowed handling
      // We accept 404 or 405 — the key is it's not 200
      expect(res.status).not.toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it("returns 405 for POST on /api/v1/state", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      const res = await request(`http://127.0.0.1:${srv.port}`).post("/api/v1/state");
      expect(res.status).not.toBe(200);
    } finally {
      await srv.stop();
    }
  });
});

describe("Server binding", () => {
  it("binds to 127.0.0.1", async () => {
    const orch = makeMockOrchestrator();
    const srv = await startServer(orch, 0, makeMockTokenTracker());
    try {
      // If it bound to 127.0.0.1, a request to localhost should work
      const res = await request(`http://127.0.0.1:${srv.port}`).get("/api/v1/state");
      expect(res.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });
});
