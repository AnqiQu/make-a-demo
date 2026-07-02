import { DaytonaOpenCodeScriptGeneration } from "../../shared/integrations/agents/daytona-opencode-script-generation";
import { ensureOpenCodeProviderDaytonaSecret } from "../../shared/integrations/agents/opencode-provider-secrets";
import { createRepoPreparationAgent } from "../../shared/integrations/agents/repo-preparation-agent-factory";
import { DaytonaSdkPreparationWorkspaceProvider } from "../../shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";
import { createResendFinalVideoEmailNotifierFromEnv } from "../../shared/integrations/email/resend-final-video-email-notifier";
import { DaytonaSandboxRunner } from "../../shared/integrations/sandbox/daytona-sandbox-runner";
import { createR2UploadPresignerFromEnv } from "../../shared/integrations/storage/r2-client";
import { R2FinalVideoStorage } from "../../shared/integrations/storage/r2-final-video-storage";
import { createNeonDemoRequestFinalVideoStore } from "../../shared/persistence/neon-demo-request-final-video-store";
import { createNeonProjectDemoGenerationQueueStore } from "../../shared/persistence/neon-project-demo-generation-queue-store";
import { compositeVideoFromScript } from "../07-compositing/composite-video";
import { finalVideoEmailsEnabled } from "../final-output/final-video-email-feature";
import { runFullPipelineJob } from "./full-pipeline-runner";
import { createPreCapturePipelineDependencies } from "./pre-capture-pipeline";
import { readRepoSecurityInput } from "./pre-capture-repo-security";
import { processNextProjectDemoGenerationJob } from "./project-demo-generation-queue";

const pollIntervalMs = Number.parseInt(
  process.env.DEMO_QUEUE_POLL_INTERVAL_MS ?? "5000",
  10,
);
const runOnce = process.env.DEMO_QUEUE_WORKER_ONCE === "1";
const daytonaApiKey = readRequiredEnv("DAYTONA_API_KEY");
const daytonaSnapshot = readOptionalEnv("MAKEADEMO_DAYTONA_SNAPSHOT");
const daytonaSubmittedCodeSnapshot = readOptionalEnv(
  "MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT",
);
const providerID = process.env.REPO_PREPARATION_PROVIDER_ID ?? "openai";
const modelID = process.env.REPO_PREPARATION_MODEL_ID ?? "gpt-4.1";
const shouldSendFinalVideoEmail = finalVideoEmailsEnabled(process.env);
const publicAppBaseUrl = shouldSendFinalVideoEmail
  ? readRequiredEnv("PUBLIC_APP_BASE_URL")
  : undefined;
const queueStore = createNeonProjectDemoGenerationQueueStore();
const demoRequestStore = createNeonDemoRequestFinalVideoStore();
const r2 = createR2UploadPresignerFromEnv();
const finalVideoStorage = new R2FinalVideoStorage(r2);
const finalVideoEmailNotifier = shouldSendFinalVideoEmail
  ? createResendFinalVideoEmailNotifierFromEnv()
  : undefined;
const sandboxProvider = new DaytonaSdkPreparationWorkspaceProvider({
  apiKey: daytonaApiKey,
  ...(daytonaSnapshot === undefined ? {} : { snapshot: daytonaSnapshot }),
});
const providerSecretName = await ensureOpenCodeProviderDaytonaSecret({
  daytonaApiKey,
  providerID,
});
const repoPreparationAgent = createRepoPreparationAgent({
  daytonaApiKey,
  ...(daytonaSnapshot === undefined ? {} : { daytonaSnapshot }),
  ...(daytonaSubmittedCodeSnapshot === undefined
    ? {}
    : { daytonaSubmittedCodeSnapshot }),
  modelID,
  providerID,
  providerSecretName,
});
const scriptGenerationAgent = new DaytonaOpenCodeScriptGeneration({
  modelID,
  providerID,
});

process.stdout.write("MakeADemo demo generation worker started\n");

do {
  const result = await processNextProjectDemoGenerationJob(queueStore, {
    async runFullPipeline(job) {
      const repoSecurity = await readRepoSecurityInput(
        sandboxProvider,
        job.repoUrl,
      );

      const pipelineResult = await runFullPipelineJob(
        {
          demoBrief: job.demoBrief,
          normalizedSupportingDocuments: job.normalizedSupportingDocuments,
          repoSecurity,
          repoUrl: job.repoUrl,
          workspaceId: job.workspaceId,
        },
        createPreCapturePipelineDependencies({
          repoPreparationAgent,
          sandboxRunner: new DaytonaSandboxRunner(),
          scriptGenerationAgent,
        }),
        {
          async compositeVideo(input) {
            return compositeVideoFromScript({
              ...input,
              demoRequestId: job.demoRequestId,
              demoRequestStore,
              ...(finalVideoEmailNotifier === undefined
                ? {}
                : { finalVideoEmailNotifier }),
              finalVideoStorage,
              ...(publicAppBaseUrl === undefined ? {} : { publicAppBaseUrl }),
            });
          },
          onProgress: (event) =>
            process.stderr.write(
              `[pipeline] ${event.stage}: ${event.status}\n`,
            ),
        },
      );

      if (!pipelineResult.finalVideo.finalVideo) {
        throw new Error("Full pipeline did not store a final video.");
      }

      return { generatedDemoUrl: pipelineResult.finalVideo.finalVideo.r2Url };
    },
  });

  if (result.status !== "idle") {
    process.stdout.write(
      `Project ${result.projectId} demo generation ${result.status}\n`,
    );
  }

  if (!runOnce && result.status === "idle") {
    await sleep(pollIntervalMs);
  }
} while (!runOnce);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}
