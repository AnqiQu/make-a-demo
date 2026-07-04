import {
  type PipelineEventLoggerOptions,
  type PipelineLogSink,
  createPipelineEventLogger,
} from "../../shared/logging/pipeline-event-logger";

type WorkerPipelineProgress = {
  stage: string;
  status: string;
};

type WorkerJobProcessed = {
  projectId: string;
  status: "completed" | "failed";
};

type ProjectDemoGenerationWorkerLoggerOptions = {
  sinks?: PipelineLogSink[];
  timestamp?: PipelineEventLoggerOptions["timestamp"];
};

/**
 * Logs Project demo generation worker events through the pipeline Pino seam.
 * Implementations must keep worker lifecycle, pipeline progress, and job status
 * entries structured so runtime workers do not write ad-hoc stdout/stderr lines.
 */
export type ProjectDemoGenerationWorkerLogger = {
  flush(): Promise<void>;
  jobProcessed(event: WorkerJobProcessed): Promise<void>;
  pipelineProgress(event: WorkerPipelineProgress): Promise<void>;
  workerStarted(): Promise<void>;
};

export function createProjectDemoGenerationWorkerLogger(
  options: ProjectDemoGenerationWorkerLoggerOptions = {},
): ProjectDemoGenerationWorkerLogger {
  const logger = createPipelineEventLogger({
    base: { component: "project-demo-generation-worker" },
    sinks: options.sinks ?? [createWorkerStdoutLogSink()],
    ...(options.timestamp === undefined
      ? {}
      : { timestamp: options.timestamp }),
  });

  return {
    flush() {
      return logger.flush();
    },
    jobProcessed(event) {
      const level = event.status === "failed" ? "error" : "info";

      return logger[level](
        {
          event: "job-processed",
          projectId: event.projectId,
          status: event.status,
        },
        `Project ${event.projectId} demo generation ${event.status}.`,
      );
    },
    pipelineProgress(event) {
      return logger.info(
        {
          event: "stage-progress",
          stage: event.stage,
          status: event.status,
        },
        `${event.stage} ${event.status}.`,
      );
    },
    workerStarted() {
      return logger.info(
        { event: "worker-started" },
        "MakeADemo demo generation worker started.",
      );
    },
  };
}

function createWorkerStdoutLogSink(): PipelineLogSink {
  return {
    write(line) {
      process.stdout.write(line);
    },
  };
}
