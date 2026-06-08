import {
  type ContextGatheringStore,
  submitContextGathering,
} from "../pipeline/01-context-gathering/context-gathering-submission";
import {
  type R2UploadStorage,
  createSupportingDocumentUpload,
  storeSupportingDocumentUpload,
} from "../shared/integrations/storage/r2-upload-presigner";

type ApiGithubDependencies = {
  createInstallUrl(input: { state: string }): string;
  listRepositories(installationId: string): Promise<
    Array<{
      fullName: string;
      private: boolean;
      repoUrl: string;
    }>
  >;
};

export type ApiAppDependencies = {
  github: ApiGithubDependencies;
  store: ContextGatheringStore;
  uploads: R2UploadStorage;
};

export type ApiApp = {
  fetch(request: Request): Promise<Response>;
};

export function createApiApp(dependencies: ApiAppDependencies): ApiApp {
  return {
    async fetch(request) {
      try {
        return await handleRequest(request, dependencies);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error ? error.message : "Unexpected API error",
          },
          { status: 400 },
        );
      }
    },
  };
}

async function handleRequest(
  request: Request,
  dependencies: ApiAppDependencies,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/github/install-url") {
    return json({
      installUrl: dependencies.github.createInstallUrl({
        state: url.searchParams.get("state") ?? crypto.randomUUID(),
      }),
    });
  }

  const repositoriesMatch =
    /^\/api\/github\/installations\/([^/]+)\/repositories$/.exec(url.pathname);
  if (request.method === "GET" && repositoriesMatch?.[1]) {
    return json({
      repositories: await dependencies.github.listRepositories(
        repositoriesMatch[1],
      ),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/uploads/presign") {
    return json(
      await createSupportingDocumentUpload(
        readUploadRequest(await request.json()),
        dependencies.uploads,
      ),
    );
  }

  if (request.method === "POST" && url.pathname === "/api/uploads") {
    return json(
      await storeSupportingDocumentUpload(
        await readMultipartUploadRequest(request),
        dependencies.uploads,
      ),
    );
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/context-gathering/submit"
  ) {
    return json(
      await submitContextGathering(await request.json(), {
        store: dependencies.store,
      }),
    );
  }

  return json({ error: "Not found" }, { status: 404 });
}

function readUploadRequest(value: unknown) {
  const record = readRecord(value, "upload request");

  return {
    draftId: readString(record, "draftId"),
    fileName: readString(record, "fileName"),
    mimeType: readString(record, "mimeType"),
    sizeBytes: readNumber(record, "sizeBytes"),
  };
}

async function readMultipartUploadRequest(request: Request) {
  const body = await request.formData();
  const draftId = body.get("draftId");
  const file = body.get("file");

  if (typeof draftId !== "string" || draftId.trim().length === 0) {
    throw new Error("draftId must be a non-empty string");
  }

  if (!(file instanceof File)) {
    throw new Error("file must be provided");
  }

  return {
    body: new Uint8Array(await file.arrayBuffer()),
    draftId,
    fileName: file.name,
    mimeType: file.type || "text/plain",
    sizeBytes: file.size,
  };
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }

  return value;
}

function readNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`);
  }

  return value;
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}
