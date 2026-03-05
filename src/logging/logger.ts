import { appendFile } from "fs/promises";
import { createWriteStream, type WriteStream } from "fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogContext {
  readonly issue_id?: string;
  readonly issue_identifier?: string;
  readonly session_id?: string;
  readonly [key: string]: unknown;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly timestamp: string;
  readonly message: string;
  readonly context: LogContext;
}

export interface LoggerConfig {
  readonly minLevel?: LogLevel;
  readonly logFile?: string;
  readonly summaryFile?: string;
}

// --- Formatters ---

function formatKeyValue(context: LogContext): string {
  return Object.entries(context)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
}

function formatStderr(record: LogRecord): string {
  const level = record.level.toUpperCase().padEnd(5);
  const kv = formatKeyValue(record.context);
  return `${level} ${record.timestamp} ${record.message}${kv ? " " + kv : ""}`;
}

function formatSummaryLine(record: LogRecord): string {
  const id = record.context.issue_identifier ?? record.context.issue_id ?? "-";
  return `[${record.timestamp}] [${id}] ${record.level.toUpperCase()}: ${record.message}`;
}

// --- Sinks ---

type SinkFn = (record: LogRecord) => void;

function stderrSink(record: LogRecord): void {
  try {
    process.stderr.write(formatStderr(record) + "\n");
  } catch {
    // Sink failures must never propagate
  }
}

function makeFileSink(filePath: string): SinkFn {
  // Use a WriteStream for efficient sequential writes
  let stream: WriteStream | null = null;
  let opening = false;
  const queue: string[] = [];

  function getStream(): WriteStream {
    if (!stream) {
      if (!opening) {
        opening = true;
        stream = createWriteStream(filePath, { flags: "a", encoding: "utf-8" });
        stream.on("error", () => {
          // Swallow write errors — sink failures must not crash orchestration
        });
        // Flush queue
        for (const line of queue.splice(0)) {
          stream.write(line + "\n");
        }
      }
    }
    return stream!;
  }

  return (record: LogRecord): void => {
    try {
      const line = JSON.stringify({
        level: record.level,
        timestamp: record.timestamp,
        message: record.message,
        ...record.context,
      });
      if (!stream && opening) {
        queue.push(line);
      } else {
        getStream().write(line + "\n");
      }
    } catch {
      // Swallow
    }
  };
}

function makeSummarySink(filePath: string): SinkFn {
  const stream = createWriteStream(filePath, { flags: "a", encoding: "utf-8" });
  stream.on("error", () => { /* swallow */ });

  // Only write summary entries for meaningful levels
  const SUMMARY_LEVELS: Set<LogLevel> = new Set(["info", "warn", "error"]);

  return (record: LogRecord): void => {
    if (!SUMMARY_LEVELS.has(record.level)) return;
    try {
      stream.write(formatSummaryLine(record) + "\n");
    } catch {
      // Swallow
    }
  };
}

// --- Logger ---

export class Logger {
  private readonly sinks: SinkFn[];
  private readonly context: LogContext;
  private readonly minLevel: LogLevel;

  constructor(sinks: SinkFn[], context: LogContext = {}, minLevel: LogLevel = "info") {
    this.sinks = sinks;
    this.context = context;
    this.minLevel = minLevel;
  }

  child(extraContext: LogContext): Logger {
    return new Logger(this.sinks, { ...this.context, ...extraContext }, this.minLevel);
  }

  debug(message: string, extra: LogContext = {}): void {
    this.write("debug", message, extra);
  }

  info(message: string, extra: LogContext = {}): void {
    this.write("info", message, extra);
  }

  warn(message: string, extra: LogContext = {}): void {
    this.write("warn", message, extra);
  }

  error(message: string, extra: LogContext = {}): void {
    this.write("error", message, extra);
  }

  private write(level: LogLevel, message: string, extra: LogContext): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    const record: LogRecord = {
      level,
      timestamp: new Date().toISOString(),
      message,
      context: { ...this.context, ...extra },
    };
    for (const sink of this.sinks) {
      try {
        sink(record);
      } catch {
        // Sink failures must never propagate to caller
      }
    }
  }
}

export function createLogger(config: LoggerConfig = {}): Logger {
  const sinks: SinkFn[] = [stderrSink];

  if (config.logFile) {
    sinks.push(makeFileSink(config.logFile));
  }
  if (config.summaryFile) {
    sinks.push(makeSummarySink(config.summaryFile));
  }

  return new Logger(sinks, {}, config.minLevel ?? "info");
}

// Exported for testing
export { formatStderr, formatSummaryLine, formatKeyValue };
