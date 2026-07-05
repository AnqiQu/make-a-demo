import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import pino, { type Logger } from "pino";

export type PipelineLogSink = {
  write(line: string): Promise<void> | void;
};

export type PipelineEventLoggerOptions = {
  base?: Record<string, unknown>;
  level?: string;
  service?: string;
  sinks: PipelineLogSink[];
  timestamp?: () => string;
};

export type PrettyPipelineLogSinkOptions = {
  write: (text: string) => void;
};

export type PipelineEventLogger = {
  child(bindings: Record<string, unknown>): PipelineEventLogger;
  debug(entry: Record<string, unknown>, message?: string): Promise<void>;
  error(entry: Record<string, unknown>, message?: string): Promise<void>;
  flush(): Promise<void>;
  info(entry: Record<string, unknown>, message?: string): Promise<void>;
  warn(entry: Record<string, unknown>, message?: string): Promise<void>;
};

type SharedLoggerState = {
  lastWrite: Promise<void> | undefined;
  writeChain: Promise<void>;
};

export function createPipelineEventLogger(
  options: PipelineEventLoggerOptions,
): PipelineEventLogger {
  const state: SharedLoggerState = {
    lastWrite: undefined,
    writeChain: Promise.resolve(),
  };
  const logger = createPinoLogger(options, state);

  return wrapPinoLogger(logger, state);
}

export function createFilePipelineLogSink(logPath: string): PipelineLogSink {
  return {
    async write(line) {
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, line);
    },
  };
}

export function createPrettyPipelineLogSink(
  options: PrettyPipelineLogSinkOptions,
): PipelineLogSink {
  return {
    write(line) {
      const entry = parseLogLine(line);
      if (entry === undefined) {
        options.write(line);
        return;
      }

      options.write(`${formatPrettyLogEntry(entry)}\n`);
    },
  };
}

function createPinoLogger(
  options: PipelineEventLoggerOptions,
  state: SharedLoggerState,
) {
  const timestamp = options.timestamp ?? (() => new Date().toISOString());
  const sinks = options.sinks;

  return pino(
    {
      base: {
        service: options.service ?? "makeademo",
        ...options.base,
      },
      formatters: {
        level: (label) => ({ level: label }),
      },
      level: options.level ?? "info",
      messageKey: "message",
      redact: {
        censor: "[Redacted]",
        paths: [
          "apiKey",
          "*.apiKey",
          "*.*.apiKey",
          "authorization",
          "*.authorization",
          "*.*.authorization",
          "password",
          "*.password",
          "*.*.password",
          "providerApiKey",
          "*.providerApiKey",
          "*.*.providerApiKey",
          "token",
          "*.token",
          "*.*.token",
        ],
      },
      timestamp: () => `,"time":${JSON.stringify(timestamp())}`,
    },
    {
      write(line) {
        const write = state.writeChain.then(async () => {
          const results = await Promise.allSettled(
            sinks.map(async (sink) => sink.write(line)),
          );
          const failedResult = results.find(
            (result) => result.status === "rejected",
          );

          if (failedResult !== undefined) {
            throw failedResult.reason;
          }
        });
        state.lastWrite = write;
        state.writeChain = write.catch(() => undefined);
      },
    },
  );
}

function parseLogLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line.trim());
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function formatPrettyLogEntry(entry: Record<string, unknown>): string {
  const time = typeof entry.time === "string" ? entry.time : undefined;
  const level = typeof entry.level === "string" ? entry.level : "info";
  const component =
    typeof entry.component === "string" ? entry.component : undefined;
  const stage = typeof entry.stage === "string" ? entry.stage : undefined;
  const event = typeof entry.event === "string" ? entry.event : undefined;
  const message =
    typeof entry.message === "string" ? entry.message : "Pipeline event.";
  const context = [component, stage, event].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );

  return [
    time === undefined ? undefined : `[${time}]`,
    level.toUpperCase().padEnd(5),
    context.length === 0 ? undefined : context.join("/"),
    message,
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" ");
}

function wrapPinoLogger(
  logger: Logger,
  state: SharedLoggerState,
): PipelineEventLogger {
  const emit = (
    level: "debug" | "error" | "info" | "warn",
    entry: Record<string, unknown>,
    message?: string,
  ) => {
    const { message: entryMessage, ...fields } = entry;
    const resolvedMessage =
      message ?? (typeof entryMessage === "string" ? entryMessage : undefined);
    const previousWrite = state.lastWrite;
    logger[level](fields, resolvedMessage);
    return state.lastWrite !== previousWrite && state.lastWrite !== undefined
      ? state.lastWrite
      : state.writeChain;
  };

  return {
    child(bindings) {
      return wrapPinoLogger(logger.child(bindings), state);
    },
    debug(entry, message) {
      return emit("debug", entry, message);
    },
    error(entry, message) {
      return emit("error", entry, message);
    },
    flush() {
      return state.writeChain;
    },
    info(entry, message) {
      return emit("info", entry, message);
    },
    warn(entry, message) {
      return emit("warn", entry, message);
    },
  };
}
