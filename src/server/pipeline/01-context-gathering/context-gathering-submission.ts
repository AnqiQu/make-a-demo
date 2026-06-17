type ProjectRepoVisibility = "private" | "public";

type ContextTranscriptMessage = {
  id: string;
  promptId: string;
  role: "assistant" | "user";
  text: string;
  timestamp: string;
};

type SupportingFileSubmission = {
  fileName: string;
  mimeType: string;
  r2Key: string;
  r2Url: string;
  sizeBytes: number;
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
  supportingFiles: SupportingFileSubmission[];
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
 * Persists Context Gathering intake and places the Project on the demo queue.
 * Implementations must perform the user, Project, and Demo Request writes in one
 * durable transaction and store queue status only on the Project.
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
      supportingFiles: input.supportingFiles.map(serializeSupportingFile),
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

function serializeSupportingFile(file: SupportingFileSubmission) {
  return JSON.stringify({
    fileName: file.fileName,
    mimeType: file.mimeType,
    r2Key: file.r2Key,
    r2Url: file.r2Url,
    sizeBytes: file.sizeBytes,
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
