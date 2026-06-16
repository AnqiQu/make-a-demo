export type PipelineStage =
  | "compositing"
  | "project-validation"
  | "repo-preparation"
  | "repo-security-screen"
  | "script-generation";

type PipelineStageEventName =
  | "stage.failed"
  | "stage.started"
  | "stage.succeeded";

type PipelineJobEventName = "job.claimed" | "job.completed" | "job.failed";

type ExternalCallEventName =
  | "external_call.failed"
  | "external_call.started"
  | "external_call.succeeded";

export type PipelineObservabilityEvent = {
  blockedNetworkAttemptCount?: number;
  createdFileCount?: number;
  demoRequestId?: string;
  diffArtifactId?: string;
  durationMs?: number;
  errorMessage?: string;
  errorType?: string;
  event: ExternalCallEventName | PipelineJobEventName | PipelineStageEventName;
  externalCall?: string;
  mockedServiceCount?: number;
  projectId?: string;
  riskCount?: number;
  runId?: string;
  sceneCount?: number;
  stage?: PipelineStage;
  status?: "claimed" | "completed" | "failed" | "started" | "succeeded";
  warningCount?: number;
  workspaceId?: string;
};

/**
 * Receives sanitized MakeADemo Pipeline observability events.
 * Implementations must not throw, must not record secrets or raw user/project
 * content, and should keep identifiers stable enough to correlate one Pipeline
 * Job across workers, stages, external seams, and durable artifacts.
 */
export interface PipelineObserver {
  record(event: PipelineObservabilityEvent): void;
}

export const noopPipelineObserver: PipelineObserver = {
  record() {},
};

export type PipelineObservationContext = {
  demoRequestId?: string;
  projectId?: string;
  runId?: string;
  workspaceId?: string;
};

export function createRecordingPipelineObserver() {
  const events: PipelineObservabilityEvent[] = [];

  return {
    events,
    record(event: PipelineObservabilityEvent) {
      events.push(event);
    },
  } satisfies PipelineObserver & { events: PipelineObservabilityEvent[] };
}

export type JsonPipelineObserverOptions = {
  now?: () => string;
  service?: string;
  write: (line: string) => void;
};

export function createJsonPipelineObserver(
  options: JsonPipelineObserverOptions,
): PipelineObserver {
  const now = options.now ?? (() => new Date().toISOString());
  const service = options.service ?? "makeademo";

  return {
    record(event) {
      try {
        options.write(
          `${JSON.stringify(toJsonLogEvent(event, service, now()))}\n`,
        );
      } catch {
        // Observability must never interrupt Pipeline Job execution.
      }
    },
  };
}

export function sanitizeObservabilityError(error: unknown) {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      errorType: error.name,
    };
  }

  return {
    errorMessage: "Unknown error",
    errorType: "UnknownError",
  };
}

function toJsonLogEvent(
  event: PipelineObservabilityEvent,
  service: string,
  time: string,
) {
  return omitUndefined({
    blockedNetworkAttemptCount: event.blockedNetworkAttemptCount,
    createdFileCount: event.createdFileCount,
    demoRequestId: event.demoRequestId,
    diffArtifactId: event.diffArtifactId,
    durationMs: event.durationMs,
    errorMessage: event.errorMessage,
    errorType: event.errorType,
    event: event.event,
    externalCall: event.externalCall,
    level: event.status === "failed" ? "error" : "info",
    mockedServiceCount: event.mockedServiceCount,
    projectId: event.projectId,
    riskCount: event.riskCount,
    runId: event.runId,
    sceneCount: event.sceneCount,
    service,
    stage: event.stage,
    status: event.status,
    time,
    warningCount: event.warningCount,
    workspaceId: event.workspaceId,
  });
}

function omitUndefined(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}
