import type { DemoBrief } from "../01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../01-context-gathering/supporting-documents";
import {
  type PipelineObserver,
  noopPipelineObserver,
  sanitizeObservabilityError,
} from "./pipeline-observer";

type ProjectDemoGenerationJob = {
  demoBrief: DemoBrief;
  demoRequestId: string;
  githubInstallationId?: string;
  /** Opaque ownership token for this processing attempt. */
  leaseToken: string;
  normalizedSupportingDocuments: NormalizedSupportingDocument[];
  projectId: string;
  repoUrl: string;
  workspaceId: string;
};

export type ProjectDemoGenerationResult =
  | {
      projectId?: undefined;
      status: "idle";
    }
  | {
      projectId: string;
      status: "completed";
    }
  | {
      projectId: string;
      status: "failed";
    };

/**
 * Claims and records status for the single Project-backed demo generation queue.
 * Implementations must atomically lease exactly one queued or expired
 * processing Project before returning it. Completion, failure, and heartbeat
 * writes must compare the opaque lease token so a stale worker cannot overwrite
 * a newer attempt. Queue state belongs only on Project records.
 */
export interface ProjectDemoGenerationQueueStore {
  claimNextQueuedProject(): Promise<ProjectDemoGenerationJob | undefined>;
  markProjectCompleted(input: {
    generatedDemoUrl: string;
    leaseToken: string;
    projectId: string;
  }): Promise<void>;
  markProjectFailed(input: {
    error: string;
    leaseToken: string;
    projectId: string;
  }): Promise<void>;
  /** Extends ownership of an in-flight job; false means another worker owns it. */
  renewProjectLease?(input: {
    leaseToken: string;
    projectId: string;
  }): Promise<boolean>;
}

type GeneratedFinalVideo = {
  generatedDemoUrl: string;
};

export type ProjectFullPipelineGenerationDependencies = {
  runFullPipeline(
    input: ProjectDemoGenerationJob,
  ): Promise<GeneratedFinalVideo>;
};

export type ProjectDemoGenerationOptions = {
  leaseHeartbeatIntervalMs?: number;
  now?: () => number;
  observer?: PipelineObserver;
};

export async function processNextProjectDemoGenerationJob(
  store: ProjectDemoGenerationQueueStore,
  dependencies: ProjectFullPipelineGenerationDependencies,
  options: ProjectDemoGenerationOptions = {},
): Promise<ProjectDemoGenerationResult> {
  const observer = options.observer ?? noopPipelineObserver;
  const now = options.now ?? Date.now;
  const job = await store.claimNextQueuedProject();
  if (!job) {
    return { status: "idle" };
  }

  const context = {
    demoRequestId: job.demoRequestId,
    projectId: job.projectId,
    workspaceId: job.workspaceId,
  };
  observer.record({
    ...context,
    event: "job.claimed",
    status: "claimed",
  });
  const startedAt = now();
  const heartbeat = startLeaseHeartbeat({
    intervalMs: options.leaseHeartbeatIntervalMs ?? 30_000,
    job,
    store,
  });

  try {
    const finalVideo = await dependencies.runFullPipeline(job);
    await heartbeat.stop();
    await store.markProjectCompleted({
      generatedDemoUrl: finalVideo.generatedDemoUrl,
      leaseToken: job.leaseToken,
      projectId: job.projectId,
    });
    observer.record({
      ...context,
      durationMs: now() - startedAt,
      event: "job.completed",
      status: "completed",
    });

    return { projectId: job.projectId, status: "completed" };
  } catch (error) {
    await heartbeat.stop({ suppressError: true });
    await store.markProjectFailed({
      error: error instanceof Error ? error.message : "Unknown queue error",
      leaseToken: job.leaseToken,
      projectId: job.projectId,
    });
    observer.record({
      ...context,
      ...sanitizeObservabilityError(error),
      durationMs: now() - startedAt,
      event: "job.failed",
      status: "failed",
    });
    return { projectId: job.projectId, status: "failed" };
  }
}

function startLeaseHeartbeat(input: {
  intervalMs: number;
  job: ProjectDemoGenerationJob;
  store: ProjectDemoGenerationQueueStore;
}) {
  let heartbeatError: unknown;
  let inFlight = Promise.resolve();
  const renew = input.store.renewProjectLease;
  if (renew === undefined) {
    return { async stop() {} };
  }
  if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
    throw new Error("leaseHeartbeatIntervalMs must be a positive number");
  }

  const timer = setInterval(() => {
    inFlight = inFlight
      .then(async () => {
        const renewed = await renew.call(input.store, {
          leaseToken: input.job.leaseToken,
          projectId: input.job.projectId,
        });
        if (!renewed) {
          throw new Error(
            `Lost processing lease for Project ${input.job.projectId}`,
          );
        }
      })
      .catch((error) => {
        heartbeatError = error;
      });
  }, input.intervalMs);
  timer.unref?.();

  return {
    async stop(options: { suppressError?: boolean } = {}) {
      clearInterval(timer);
      await inFlight;
      if (heartbeatError !== undefined && options.suppressError !== true) {
        throw heartbeatError;
      }
    },
  };
}
