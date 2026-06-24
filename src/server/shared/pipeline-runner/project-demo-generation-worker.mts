import { compositeVideoFromScript } from "../../pipeline/07-compositing/composite-video";
import { finalVideoEmailsEnabled } from "../../pipeline/final-output/final-video-email-feature";
import { DaytonaOpenCodeAgent } from "../integrations/agents/daytona-opencode-agent";
import { DaytonaSdkPreparationWorkspaceProvider } from "../integrations/daytona/daytona-sdk-preparation-workspace-provider";
import { createResendFinalVideoEmailNotifierFromEnv } from "../integrations/email/resend-final-video-email-notifier";
import {
  DaytonaSandboxRunner,
  restartPreparedDemoForFreshCapture,
} from "../integrations/sandbox/daytona-sandbox-runner";
import { createR2UploadPresignerFromEnv } from "../integrations/storage/r2-client";
import { R2FinalVideoStorage } from "../integrations/storage/r2-final-video-storage";
import { R2SupportingDocumentLoader } from "../integrations/storage/r2-supporting-document-loader";
import { createPipelineEventLogger } from "../logging/pipeline-event-logger";
import { createNeonDemoRequestFinalVideoStore } from "../persistence/neon-demo-request-final-video-store";
import { createNeonProjectDemoGenerationQueueStore } from "../persistence/neon-project-demo-generation-queue-store";
import { runFullPipelineJob } from "./full-pipeline-runner";
import { createJsonPipelineObserver } from "./pipeline-observer";
import { processNextProjectDemoGenerationJob } from "./project-demo-generation-queue";
import { createStage1PipelineDependencies } from "./stage1-pipeline";
import { readRepoSecurityInput } from "./stage1-repo-security";

const pollIntervalMs = Number.parseInt(
  process.env.DEMO_QUEUE_POLL_INTERVAL_MS ?? "5000",
  10,
);
const runOnce = process.env.DEMO_QUEUE_WORKER_ONCE === "1";
const daytonaApiKey = readRequiredEnv("DAYTONA_API_KEY");
const daytonaSnapshot = process.env.DAYTONA_SNAPSHOT;
const providerID = process.env.REPO_PREPARATION_PROVIDER_ID ?? "openai";
const modelID = process.env.REPO_PREPARATION_MODEL_ID ?? "gpt-4.1";
const demoRequestStore = createNeonDemoRequestFinalVideoStore();
const r2 = createR2UploadPresignerFromEnv();
const queueStore = createNeonProjectDemoGenerationQueueStore(
  undefined,
  new R2SupportingDocumentLoader(r2),
);
const finalVideoStorage = new R2FinalVideoStorage(r2);
const observer = createJsonPipelineObserver({
  service: "makeademo-demo-generation-worker",
  write: (line) => process.stdout.write(line),
});
const logger = createPipelineEventLogger({
  base: { component: "demo-generation-worker" },
  service: "makeademo-demo-generation-worker",
  sinks: [{ write: (line) => void process.stdout.write(line) }],
});
const sandboxProvider = new DaytonaSdkPreparationWorkspaceProvider({
  apiKey: daytonaApiKey,
  ...(daytonaSnapshot === undefined ? {} : { snapshot: daytonaSnapshot }),
});
const openCodeAgent = new DaytonaOpenCodeAgent({
  daytonaApiKey,
  ...(daytonaSnapshot === undefined ? {} : { daytonaSnapshot }),
  modelID,
  providerApiKey: readProviderApiKey(providerID),
  providerID,
});
const finalVideoEmailNotifier = finalVideoEmailsEnabled(process.env)
  ? createResendFinalVideoEmailNotifierFromEnv()
  : undefined;
const publicAppBaseUrl = finalVideoEmailsEnabled(process.env)
  ? readRequiredEnv("PUBLIC_APP_BASE_URL")
  : undefined;

await logger.info(
  {
    event: "demo-generation-worker.started",
    pollIntervalMs,
    runOnce,
  },
  "MakeADemo demo generation worker started.",
);

do {
  const result = await processNextProjectDemoGenerationJob(
    queueStore,
    {
      async runFullPipeline(job) {
        const repoSecurity = await readRepoSecurityInput(
          sandboxProvider,
          job.repoUrl,
          { logger: logger.child({ projectId: job.projectId }) },
        );

        const result = await runFullPipelineJob(
          {
            demoBrief: job.demoBrief,
            normalizedSupportingDocuments: job.normalizedSupportingDocuments,
            repoSecurity,
            repoUrl: job.repoUrl,
            workspaceId: job.workspaceId,
          },
          createStage1PipelineDependencies({
            repoPreparationAgent: openCodeAgent,
            sandboxRunner: new DaytonaSandboxRunner(),
            scriptGenerationAgent: openCodeAgent,
          }),
          {
            async compositeVideo(input) {
              return compositeVideoFromScript({
                ...input,
                demoRequestId: job.demoRequestId,
                demoRequestStore,
                finalVideoStorage,
                ...(finalVideoEmailNotifier === undefined
                  ? {}
                  : { finalVideoEmailNotifier }),
                ...(publicAppBaseUrl === undefined ? {} : { publicAppBaseUrl }),
                retainLocalOutput: true,
              });
            },
            context: {
              demoRequestId: job.demoRequestId,
              projectId: job.projectId,
            },
            demoRequestScriptStore: demoRequestStore,
            observer,
            async prepareFreshCaptureState({ stage1 }) {
              if (stage1.preparationWorkspace === undefined) {
                throw new Error(
                  "Fresh Footage Capture state requires the prepared workspace.",
                );
              }

              return await restartPreparedDemoForFreshCapture({
                preparationManifest: stage1.preparationManifest,
                preparationWorkspace: stage1.preparationWorkspace,
              });
            },
            reviewDraftComposite:
              openCodeAgent.reviewDraftComposite.bind(openCodeAgent),
          },
        );

        if (!result.finalVideo.finalVideo) {
          throw new Error("Full pipeline did not store a final video");
        }

        return { generatedDemoUrl: result.finalVideo.finalVideo.r2Url };
      },
    },
    { observer },
  );

  if (result.status !== "idle") {
    await logger.info(
      {
        event: "demo-generation-worker.job.processed",
        projectId: result.projectId,
        status: result.status,
      },
      `Project demo generation ${result.status}.`,
    );
  }

  if (!runOnce && result.status === "idle") {
    await sleep(pollIntervalMs);
  }
} while (!runOnce);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readProviderApiKey(provider: string): string {
  if (provider !== "openai") {
    throw new Error(`Unsupported Repo Preparation provider: ${provider}`);
  }

  return readRequiredEnv("OPENAI_API_KEY");
}

function readRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}
