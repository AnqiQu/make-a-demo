import { finalVideoEmailsEnabled } from "../../pipeline/final-output/final-video-email-feature";
import { DaytonaOpenCodeScriptGenerationAgent } from "../integrations/agents/daytona-opencode-script-generation-agent";
import { createRepoPreparationAgent } from "../integrations/agents/repo-preparation-agent-factory";
import { DaytonaSdkPreparationWorkspaceProvider } from "../integrations/daytona/daytona-sdk-preparation-workspace-provider";
import { createResendFinalVideoEmailNotifierFromEnv } from "../integrations/email/resend-final-video-email-notifier";
import { DaytonaSandboxRunner } from "../integrations/sandbox/daytona-sandbox-runner";
import { createR2UploadPresignerFromEnv } from "../integrations/storage/r2-client";
import { R2FinalVideoStorage } from "../integrations/storage/r2-final-video-storage";
import { createNeonDemoRequestFinalVideoStore } from "../persistence/neon-demo-request-final-video-store";
import { createNeonProjectDemoGenerationQueueStore } from "../persistence/neon-project-demo-generation-queue-store";
import { createJsonPipelineObserver } from "./pipeline-observer";
import { runPipelineJob } from "./pipeline-orchestrator";
import { processNextProjectDemoGenerationJob } from "./project-demo-generation-queue";
import { CompositeProjectFinalVideoGenerator } from "./project-final-video-generator";
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
const queueStore = createNeonProjectDemoGenerationQueueStore();
const demoRequestStore = createNeonDemoRequestFinalVideoStore();
const r2 = createR2UploadPresignerFromEnv();
const observer = createJsonPipelineObserver({
  service: "makeademo-demo-generation-worker",
  write: (line) => process.stdout.write(line),
});
const sandboxProvider = new DaytonaSdkPreparationWorkspaceProvider({
  apiKey: daytonaApiKey,
  ...(daytonaSnapshot === undefined ? {} : { snapshot: daytonaSnapshot }),
});
const repoPreparationAgent = createRepoPreparationAgent({
  daytonaApiKey,
  ...(daytonaSnapshot === undefined ? {} : { daytonaSnapshot }),
  modelID,
  providerApiKey: readProviderApiKey(providerID),
  providerID,
});
const scriptGenerationAgent = new DaytonaOpenCodeScriptGenerationAgent({
  modelID,
  providerApiKey: readProviderApiKey(providerID),
  providerID,
});
const finalVideoGenerator = new CompositeProjectFinalVideoGenerator({
  demoRequestStore,
  finalVideoStorage: new R2FinalVideoStorage(r2),
  observer,
  ...(finalVideoEmailsEnabled(process.env)
    ? {
        finalVideoEmailNotifier: createResendFinalVideoEmailNotifierFromEnv(),
        publicAppBaseUrl: readRequiredEnv("PUBLIC_APP_BASE_URL"),
      }
    : {}),
});

process.stdout.write("MakeADemo demo generation worker started\n");

do {
  const result = await processNextProjectDemoGenerationJob(
    queueStore,
    {
      generateFinalVideo: (input) =>
        finalVideoGenerator.generateFinalVideo(input),
      async runPipeline(job) {
        const repoSecurity = await readRepoSecurityInput(
          sandboxProvider,
          job.repoUrl,
        );

        return runPipelineJob(
          {
            demoBrief: job.demoBrief,
            normalizedSupportingDocuments: job.normalizedSupportingDocuments,
            repoSecurity,
            repoUrl: job.repoUrl,
            workspaceId: job.workspaceId,
          },
          createStage1PipelineDependencies({
            repoPreparationAgent,
            sandboxRunner: new DaytonaSandboxRunner(),
          }),
          {
            context: {
              demoRequestId: job.demoRequestId,
              projectId: job.projectId,
            },
            observer,
          },
        );
      },
    },
    { observer },
  );

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
