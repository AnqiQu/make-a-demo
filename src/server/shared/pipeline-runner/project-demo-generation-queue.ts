import type { DemoBrief } from "../../pipeline/01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../../pipeline/01-context-gathering/supporting-documents";
import type { PipelineJobResult } from "./pipeline-job";
import {
  type PipelineObserver,
  noopPipelineObserver,
  sanitizeObservabilityError,
} from "./pipeline-observer";

type ProjectDemoGenerationJob = {
  demoBrief: DemoBrief;
  demoRequestId: string;
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
 * Implementations must make `claimNextQueuedProject` move exactly one queued
 * Project to processing before returning it, and must store queue state only on
 * Project records.
 */
export interface ProjectDemoGenerationQueueStore {
  claimNextQueuedProject(): Promise<ProjectDemoGenerationJob | undefined>;
  markProjectCompleted(input: {
    generatedDemoUrl: string;
    projectId: string;
  }): Promise<void>;
  markProjectFailed(input: { error: string; projectId: string }): Promise<void>;
}

type GeneratedFinalVideo = {
  generatedDemoUrl: string;
};

/**
 * Runs the final output portion of a Project job.
 * Implementations must not resolve until Compositing has generated the final
 * video, linked it to the Demo Request, and completed any enabled user
 * notification.
 */
export interface ProjectFinalVideoGenerator {
  generateFinalVideo(input: {
    demoRequestId: string;
    pipelineResult: Extract<PipelineJobResult, { status: "succeeded" }>;
    projectId: string;
  }): Promise<GeneratedFinalVideo>;
}

export type ProjectDemoGenerationDependencies = ProjectFinalVideoGenerator & {
  runPipeline(input: ProjectDemoGenerationJob): Promise<PipelineJobResult>;
};

export type ProjectFullPipelineGenerationDependencies = {
  runFullPipeline(
    input: ProjectDemoGenerationJob,
  ): Promise<GeneratedFinalVideo>;
};

export type ProjectDemoGenerationOptions = {
  now?: () => number;
  observer?: PipelineObserver;
};

export async function processNextProjectDemoGenerationJob(
  store: ProjectDemoGenerationQueueStore,
  dependencies:
    | ProjectDemoGenerationDependencies
    | ProjectFullPipelineGenerationDependencies,
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

  try {
    if ("runFullPipeline" in dependencies) {
      const finalVideo = await dependencies.runFullPipeline(job);
      await store.markProjectCompleted({
        generatedDemoUrl: finalVideo.generatedDemoUrl,
        projectId: job.projectId,
      });
      observer.record({
        ...context,
        durationMs: now() - startedAt,
        event: "job.completed",
        status: "completed",
      });

      return { projectId: job.projectId, status: "completed" };
    }

    const pipelineResult = await dependencies.runPipeline(job);
    if (pipelineResult.status !== "succeeded") {
      await store.markProjectFailed({
        error: pipelineResult.status,
        projectId: job.projectId,
      });
      observer.record({
        ...context,
        durationMs: now() - startedAt,
        errorMessage: pipelineResult.status,
        errorType: "PipelineJobFailed",
        event: "job.failed",
        status: "failed",
      });
      return { projectId: job.projectId, status: "failed" };
    }

    const finalVideo = await dependencies.generateFinalVideo({
      demoRequestId: job.demoRequestId,
      pipelineResult,
      projectId: job.projectId,
    });
    await store.markProjectCompleted({
      generatedDemoUrl: finalVideo.generatedDemoUrl,
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
    await store.markProjectFailed({
      error: error instanceof Error ? error.message : "Unknown queue error",
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
