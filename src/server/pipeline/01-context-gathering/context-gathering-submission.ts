type ProjectRepoVisibility = "private" | "public";

type ContextTranscriptMessage = {
  id: string;
  promptId: string;
  role: "assistant" | "user";
  text: string;
  timestamp: string;
};

export type ContextGatheringSubmission = {
  contact: {
    email: string;
    name: string;
  };
  contextTranscript: ContextTranscriptMessage[];
  githubInstallationId?: string;
  repoUrl: string;
  repoVisibility: ProjectRepoVisibility;
  structuredContext: {
    importantFeatures: string;
    productSummary: string;
    requestedDurationSeconds: number;
    targetUsers: string;
  };
  supportingFiles: Array<{
    fileName: string;
    mimeType: string;
    r2Key: string;
    r2Url: string;
    sizeBytes: number;
  }>;
};

type ContextGatheringProjectContext = {
  structuredContext: ContextGatheringSubmission["structuredContext"];
  transcript: ContextTranscriptMessage[];
};

export type ContextGatheringStoreInput = {
  project: {
    context: ContextGatheringProjectContext;
    githubInstallationId?: string;
    repoUrl: string;
    repoVisibility: ProjectRepoVisibility;
    supportingFiles: string[];
  };
  user: {
    email: string;
    name: string;
  };
};

export type ContextGatheringSubmitResult = {
  demoRequestId: string;
  projectId: string;
  status: "queued";
};

/**
 * Persists Context Gathering intake and creates the initial queued demo request.
 * Implementations must perform the user, Project, and Demo Request writes in one
 * durable transaction and leave downstream pipeline work queued, not started.
 */
export interface ContextGatheringStore {
  createQueuedProject(
    input: ContextGatheringStoreInput,
  ): Promise<ContextGatheringSubmitResult>;
}

export async function submitContextGathering(
  input: ContextGatheringSubmission,
  dependencies: { store: ContextGatheringStore },
): Promise<ContextGatheringSubmitResult> {
  validateSubmission(input);

  return dependencies.store.createQueuedProject({
    project: {
      context: {
        structuredContext: input.structuredContext,
        transcript: input.contextTranscript,
      },
      repoUrl: input.repoUrl,
      repoVisibility: input.repoVisibility,
      supportingFiles: input.supportingFiles.map((file) => file.r2Url),
      ...(input.githubInstallationId === undefined
        ? {}
        : { githubInstallationId: input.githubInstallationId }),
    },
    user: {
      email: input.contact.email,
      name: input.contact.name,
    },
  });
}

function validateSubmission(input: ContextGatheringSubmission) {
  if (!input.repoUrl.startsWith("https://github.com/")) {
    throw new Error("repoUrl must be a GitHub HTTPS URL");
  }

  if (input.repoVisibility === "private" && !input.githubInstallationId) {
    throw new Error("githubInstallationId is required for private repos");
  }

  if (!input.contact.email.includes("@")) {
    throw new Error("email must be valid");
  }

  if (input.contact.name.trim().length === 0) {
    throw new Error("name is required");
  }

  const duration = input.structuredContext.requestedDurationSeconds;
  if (!Number.isFinite(duration) || duration < 30 || duration > 180) {
    throw new Error("requestedDurationSeconds must be between 30 and 180");
  }
}
