import { readSupportingDocumentUpload } from "./supporting-documents";

type ProjectRepoVisibility = "private" | "public";

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
  githubInstallationId?: string;
  repoUrl: string;
  repoVisibility: ProjectRepoVisibility;
  structuredContext: {
    importantFeatures: string;
    preferredAppDir?: string;
    productSummary: string;
    requestedDurationSeconds: number;
    targetUsers: string;
  };
  supportingFiles: SupportingFileSubmission[];
};

type ContextGatheringProjectContext = {
  importantFeatures: string;
  preferredAppDir?: string;
  productSummary: string;
  requestedDurationSeconds: number;
  targetUsers: string;
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
      context: createProjectContext(input.structuredContext),
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

function createProjectContext(
  input: ContextGatheringSubmission["structuredContext"],
): ContextGatheringProjectContext {
  return {
    importantFeatures: input.importantFeatures,
    ...(input.preferredAppDir === undefined
      ? {}
      : { preferredAppDir: input.preferredAppDir }),
    productSummary: input.productSummary,
    requestedDurationSeconds: input.requestedDurationSeconds,
    targetUsers: input.targetUsers,
  };
}

function serializeSupportingFile(file: SupportingFileSubmission) {
  const upload = readSupportingDocumentUpload({
    artifactId: readNonEmptyString(file.r2Url, "r2Url"),
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  });

  return JSON.stringify({
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    r2Key: readNonEmptyString(file.r2Key, "r2Key"),
    r2Url: upload.artifactId,
    sizeBytes: upload.sizeBytes,
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

  const preferredAppDir = input.structuredContext.preferredAppDir;
  if (
    preferredAppDir !== undefined &&
    (preferredAppDir.trim().length === 0 ||
      preferredAppDir !== preferredAppDir.trim() ||
      preferredAppDir.startsWith("/") ||
      preferredAppDir.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(preferredAppDir) ||
      preferredAppDir.includes("\0") ||
      preferredAppDir.split(/[\\/]/).includes(".."))
  ) {
    throw new Error("preferredAppDir must be a repo-relative path");
  }

  if (input.contact.name.trim().length === 0) {
    throw new Error("name is required");
  }

  if (!Array.isArray(input.supportingFiles)) {
    throw new Error("supportingFiles must be an array");
  }

  const duration = input.structuredContext.requestedDurationSeconds;
  if (!Number.isFinite(duration) || duration < 30 || duration > 180) {
    throw new Error("requestedDurationSeconds must be between 30 and 180");
  }
}

function readNonEmptyString(value: unknown, key: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }

  return value;
}
