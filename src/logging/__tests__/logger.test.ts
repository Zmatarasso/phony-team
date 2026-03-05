import { writeFile, rm, readFile, mkdtemp } from "fs/promises";
import path from "path";
import os from "os";
import {
  Logger,
  createLogger,
  formatStderr,
  formatSummaryLine,
  formatKeyValue,
} from "../logger.js";
import type { LogRecord, LogContext } from "../logger.js";

function makeRecord(
  overrides: Partial<LogRecord> & { context?: LogContext } = {},
): LogRecord {
  return {
    level: "info",
    timestamp: "2024-01-15T10:00:00.000Z",
    message: "test message",
    context: {},
    ...overrides,
  };
}

// --- Formatters ---

describe("formatKeyValue", () => {
  it("formats context as key=value pairs", () => {
    expect(formatKeyValue({ issue_id: "123", issue_identifier: "PHONY-1" })).toBe(
      "issue_id=123 issue_identifier=PHONY-1",
    );
  });

  it("omits null and undefined values", () => {
    expect(formatKeyValue({ a: "x", b: null, c: undefined, d: "y" })).toBe("a=x d=y");
  });

  it("returns empty string for empty context", () => {
    expect(formatKeyValue({})).toBe("");
  });
});

describe("formatStderr", () => {
  it("includes level, timestamp, message", () => {
    const line = formatStderr(makeRecord());
    expect(line).toContain("INFO");
    expect(line).toContain("2024-01-15T10:00:00.000Z");
    expect(line).toContain("test message");
  });

  it("appends key=value pairs when context is present", () => {
    const line = formatStderr(
      makeRecord({ context: { issue_identifier: "PHONY-1", session_id: "s1" } }),
    );
    expect(line).toContain("issue_identifier=PHONY-1");
    expect(line).toContain("session_id=s1");
  });

  it("does not append trailing space when context is empty", () => {
    const line = formatStderr(makeRecord({ context: {} }));
    expect(line).not.toMatch(/ $/);
  });
});

describe("formatSummaryLine", () => {
  it("uses issue_identifier in the prefix", () => {
    const line = formatSummaryLine(
      makeRecord({ context: { issue_identifier: "PHONY-42" } }),
    );
    expect(line).toContain("[PHONY-42]");
    expect(line).toContain("INFO");
    expect(line).toContain("test message");
  });

  it("falls back to issue_id when issue_identifier is absent", () => {
    const line = formatSummaryLine(makeRecord({ context: { issue_id: "id-99" } }));
    expect(line).toContain("[id-99]");
  });

  it("uses '-' placeholder when no identifier context is present", () => {
    const line = formatSummaryLine(makeRecord({ context: {} }));
    expect(line).toContain("[-]");
  });
});

// --- Logger ---

describe("Logger.child", () => {
  it("merges parent context into all child log calls", () => {
    const records: LogRecord[] = [];
    const logger = new Logger([(r) => records.push(r)], { issue_id: "abc" });
    const child = logger.child({ session_id: "s1" });
    child.info("hello");
    expect(records[0]?.context.issue_id).toBe("abc");
    expect(records[0]?.context.session_id).toBe("s1");
  });

  it("child context overrides parent context for same keys", () => {
    const records: LogRecord[] = [];
    const logger = new Logger([(r) => records.push(r)], { issue_id: "parent" });
    const child = logger.child({ issue_id: "child" });
    child.info("msg");
    expect(records[0]?.context.issue_id).toBe("child");
  });
});

describe("Logger level filtering", () => {
  it("emits records at or above minLevel", () => {
    const records: LogRecord[] = [];
    const logger = new Logger([(r) => records.push(r)], {}, "warn");
    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");
    expect(records.map((r) => r.level)).toEqual(["warn", "error"]);
  });

  it("emits all levels when minLevel is debug", () => {
    const records: LogRecord[] = [];
    const logger = new Logger([(r) => records.push(r)], {}, "debug");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(records).toHaveLength(4);
  });
});

describe("Logger sink failure resilience", () => {
  it("does not throw when a sink throws", () => {
    const throwingSink = (): void => { throw new Error("sink is broken"); };
    const logger = new Logger([throwingSink]);
    expect(() => logger.info("hello")).not.toThrow();
  });

  it("continues writing to subsequent sinks even if one throws", () => {
    const records: LogRecord[] = [];
    const throwingSink = (): void => { throw new Error("broken"); };
    const goodSink = (r: LogRecord): void => { records.push(r); };
    const logger = new Logger([throwingSink, goodSink]);
    logger.info("test");
    expect(records).toHaveLength(1);
  });
});

describe("Logger context fields", () => {
  it("attaches issue_id, issue_identifier, session_id to records", () => {
    const records: LogRecord[] = [];
    const logger = new Logger([(r) => records.push(r)], {
      issue_id: "i1",
      issue_identifier: "PHONY-1",
      session_id: "sess-1",
    });
    logger.info("msg");
    const ctx = records[0]?.context;
    expect(ctx?.issue_id).toBe("i1");
    expect(ctx?.issue_identifier).toBe("PHONY-1");
    expect(ctx?.session_id).toBe("sess-1");
  });

  it("merges extra context passed per call", () => {
    const records: LogRecord[] = [];
    const logger = new Logger([(r) => records.push(r)]);
    logger.info("msg", { attempt: 2 });
    expect(records[0]?.context.attempt).toBe(2);
  });
});

// --- File sinks (integration) ---

describe("createLogger file sinks", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "symphony-log-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes newline-delimited JSON to the log file", async () => {
    const logFile = path.join(tmpDir, "symphony.log");
    const logger = createLogger({ logFile });
    logger.info("hello world", { issue_identifier: "PHONY-1" });

    // Allow the write stream to flush
    await new Promise((r) => setTimeout(r, 100));
    const content = await readFile(logFile, "utf-8");
    const line = JSON.parse(content.trim().split("\n")[0] ?? "{}") as Record<string, unknown>;
    expect(line["level"]).toBe("info");
    expect(line["message"]).toBe("hello world");
    expect(line["issue_identifier"]).toBe("PHONY-1");
  });

  it("writes human-readable grouped lines to the summary file", async () => {
    const summaryFile = path.join(tmpDir, "summary.log");
    const logger = createLogger({ summaryFile });
    logger.info("session started", { issue_identifier: "PHONY-2" });

    await new Promise((r) => setTimeout(r, 100));
    const content = await readFile(summaryFile, "utf-8");
    expect(content).toContain("[PHONY-2]");
    expect(content).toContain("session started");
  });

  it("does not write debug lines to the summary file", async () => {
    const summaryFile = path.join(tmpDir, "summary-debug.log");
    const logger = createLogger({ summaryFile, minLevel: "debug" });
    logger.debug("low-level detail", { issue_identifier: "PHONY-3" });

    await new Promise((r) => setTimeout(r, 100));
    // File may not exist at all (no writes), or exist with no content
    const content = await readFile(summaryFile, "utf-8").catch(() => "");
    expect(content).toBe("");
  });

  it("does not throw when log file path is not writable", async () => {
    const logger = createLogger({ logFile: "/nonexistent/path/symphony.log" });
    expect(() => logger.info("this should not throw")).not.toThrow();
  });
});
