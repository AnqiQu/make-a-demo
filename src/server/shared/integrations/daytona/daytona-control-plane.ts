import { AgentHarnessControlPlaneError } from "../../../agent-harness/daytona/workspace.interface";
import type { PipelineEventLogger } from "../../logging/pipeline-event-logger";

/**
 * The one classification every Daytona control-plane failure passes through:
 *
 * - `conflict` — the resource is mid-state-change (HTTP 409, `errorCode:
 *   Conflict`, or the message shapes Daytona actually emits). An
 *   in-progress operation means wait for it to settle and re-issue, not
 *   die: a retry-after-timeout can itself manufacture the 409.
 * - `transient` — transport-level loss (HTTP 5xx, connection resets,
 *   timeouts) worth an escalating retry sized for control-plane windows.
 * - `fatal` — everything else. Fatal errors are always rethrown raw so
 *   call-site matchers (restricted network policy, not-found,
 *   sandbox-not-started) keep firing on the original error.
 */
export type DaytonaControlPlaneErrorClassification =
  | "conflict"
  | "fatal"
  | "transient";

export function classifyDaytonaControlPlaneError(
  error: unknown,
): DaytonaControlPlaneErrorClassification {
  const candidate = (
    typeof error === "object" && error !== null ? error : {}
  ) as { errorCode?: unknown; message?: unknown; name?: unknown };
  const message = String(candidate.message ?? "");
  if (
    readHttpStatusCode(error) === 409 ||
    candidate.errorCode === "Conflict" ||
    /state change in progress|state is changing|operation is already in progress/i.test(
      message,
    )
  ) {
    return "conflict";
  }
  const statusCode = readHttpStatusCode(error);
  if (
    (statusCode !== undefined && statusCode >= 500) ||
    /Connection|Timeout/i.test(String(candidate.name ?? "")) ||
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|Operation timed out|socket hang up|socket connection was closed|status code 5\d\d/i.test(
      message,
    )
  ) {
    return "transient";
  }
  return "fatal";
}

function readHttpStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const candidate = error as {
    response?: { status?: unknown };
    status?: unknown;
    statusCode?: unknown;
  };
  for (const value of [
    candidate.statusCode,
    candidate.status,
    candidate.response?.status,
  ]) {
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

type DaytonaControlPlaneRunOptions = {
  /** Conflict polls before giving up; each waits `conflictPollDelayMs`. */
  conflictPollLimit?: number;
  /** Transient-retry delays; its length bounds the retries. */
  ladderMs?: readonly number[];
  /** Runs before each wait — seams with their own retry events hook here. */
  onRetry?: (error: unknown, delayMs: number) => Promise<void> | void;
  sandboxId?: string;
  /**
   * When false, exhaustion rethrows the raw error for seams that carry
   * their own infrastructure-family wrapping (artifact transfers).
   */
  wrapExhausted?: boolean;
};

export type DaytonaControlPlaneEnvelope = {
  run<T>(
    operation: string,
    attempt: () => Promise<T>,
    options?: DaytonaControlPlaneRunOptions,
  ): Promise<T>;
};

/**
 * Escalating transient ladder sized for control-plane windows, not blips:
 * a multi-minute Daytona event outlives any few-second budget (the prior
 * five-second total died against every real window, 2026-08-09). Jitter
 * spreads a herd of parallel matrix entries instead of resynchronizing
 * them onto the recovering service.
 */
const controlLadderMs = [
  2_000, 5_000, 10_000, 20_000, 40_000, 60_000, 90_000,
] as const;
const conflictPollDelayMs = 5_000;
const defaultConflictPollLimit = 24;

/**
 * The one envelope every re-issuable Daytona control-plane touch runs
 * through: sandbox create/delete/start, network updates, PTY session
 * creation, and filesystem transfers. Each attempt emits a seam-attributed
 * `daytona.<operation>.attempt/retrying/failed` pipeline-log event with
 * the sandbox id, so a silent multi-minute gap is always attributable and
 * a terminal failure names its seam.
 *
 * Deliberately excluded: command execution and managed-app session
 * commands. A transport error there can mask a command that already ran,
 * so a blind re-issue could double side effects — those failures surface
 * into the validation record instead.
 *
 * Events go to the local pipeline log only: control-plane observability
 * must never itself depend on the control plane.
 */
export function createDaytonaControlPlaneEnvelope(envelopeOptions: {
  logger: Pick<PipelineEventLogger, "error" | "info" | "warn">;
  random?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}): DaytonaControlPlaneEnvelope {
  const random = envelopeOptions.random ?? Math.random;
  const wait =
    envelopeOptions.wait ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const logBestEffort = async (
    level: "error" | "info" | "warn",
    entry: Record<string, unknown>,
    message: string,
  ) => {
    try {
      await envelopeOptions.logger[level](entry, message);
    } catch {
      // Attribution must never replace the operation it attributes.
    }
  };
  const jittered = (delayMs: number) =>
    Math.round(delayMs * (0.75 + 0.5 * random()));

  return {
    async run<T>(
      operation: string,
      attempt: () => Promise<T>,
      options: DaytonaControlPlaneRunOptions = {},
    ): Promise<T> {
      const ladderMs = options.ladderMs ?? controlLadderMs;
      const conflictPollLimit =
        options.conflictPollLimit ?? defaultConflictPollLimit;
      const attribution =
        options.sandboxId === undefined ? {} : { sandboxId: options.sandboxId };
      let transientRetries = 0;
      let conflictPolls = 0;
      for (let attemptNumber = 1; ; attemptNumber += 1) {
        await logBestEffort(
          "info",
          {
            attempt: attemptNumber,
            event: `daytona.${operation}.attempt`,
            ...attribution,
          },
          `Daytona ${operation} attempt ${attemptNumber}.`,
        );
        try {
          return await attempt();
        } catch (error) {
          const classification = classifyDaytonaControlPlaneError(error);
          const delayMs =
            classification === "conflict"
              ? conflictPolls < conflictPollLimit
                ? jittered(conflictPollDelayMs)
                : undefined
              : classification === "transient"
                ? transientRetries < ladderMs.length
                  ? jittered(ladderMs[transientRetries] ?? 0)
                  : undefined
                : undefined;
          if (classification === "fatal" || delayMs === undefined) {
            await logBestEffort(
              "error",
              {
                attempt: attemptNumber,
                classification,
                error: formatErrorDiagnostic(error),
                event: `daytona.${operation}.failed`,
                ...attribution,
              },
              `Daytona ${operation} failed (${classification}) after ${attemptNumber} attempt(s).`,
            );
            if (classification === "fatal" || options.wrapExhausted === false) {
              throw error;
            }
            throw new AgentHarnessControlPlaneError({
              attempts: attemptNumber,
              cause: error,
              classification,
              operation,
              ...attribution,
            });
          }
          if (classification === "conflict") {
            conflictPolls += 1;
          } else {
            transientRetries += 1;
          }
          await logBestEffort(
            "warn",
            {
              attempt: attemptNumber,
              classification,
              delayMs,
              error: formatErrorDiagnostic(error),
              event: `daytona.${operation}.retrying`,
              ...attribution,
            },
            `Daytona ${operation} ${classification}; retrying in ${delayMs}ms.`,
          );
          await options.onRetry?.(error, delayMs);
          await wait(delayMs);
        }
      }
    },
  };
}

export function formatErrorDiagnostic(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
