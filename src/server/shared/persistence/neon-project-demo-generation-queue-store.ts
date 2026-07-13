import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, or } from "drizzle-orm";
import type { ProjectDemoGenerationQueueStore } from "../../pipeline/00-orchestration/project-demo-generation-queue";
import type { NormalizedSupportingDocument } from "../../pipeline/01-context-gathering/supporting-documents";
import { demoRequests, projects } from "./schema";

export type QueuedSupportingDocumentUpload = {
  fileName: string;
  mimeType: string;
  r2Key: string;
  r2Url: string;
  sizeBytes: number;
};

type SupportingDocumentLoader = {
  loadSupportingDocuments(
    input: QueuedSupportingDocumentUpload[],
  ): Promise<NormalizedSupportingDocument[]>;
};

type ProjectQueueDatabase = {
  select(selection: unknown): unknown;
  update(table: unknown): unknown;
};

type ProjectQueueLeaseOptions = {
  createLeaseToken?: () => string;
  leaseDurationMs?: number;
  now?: () => Date;
};

type SelectQueuedProjectQuery = {
  from(table: unknown): {
    innerJoin(
      table: unknown,
      condition: unknown,
    ): {
      where(condition: unknown): {
        orderBy(ordering: unknown): {
          limit(count: number): Promise<Array<Record<string, unknown>>>;
        };
      };
    };
  };
};

type UpdateReturningQuery = {
  set(values: Record<string, unknown>): {
    where(condition: unknown): {
      returning(selection: unknown): Promise<Array<Record<string, unknown>>>;
    };
  };
};

export class NeonProjectDemoGenerationQueueStore
  implements ProjectDemoGenerationQueueStore
{
  private readonly db: ProjectQueueDatabase;
  private readonly supportingDocumentLoader:
    | SupportingDocumentLoader
    | undefined;
  private readonly createLeaseToken: () => string;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;

  constructor(
    db: ProjectQueueDatabase,
    supportingDocumentLoader?: SupportingDocumentLoader,
    options: ProjectQueueLeaseOptions = {},
  ) {
    this.db = db;
    this.supportingDocumentLoader = supportingDocumentLoader;
    this.createLeaseToken = options.createLeaseToken ?? randomUUID;
    this.leaseDurationMs = options.leaseDurationMs ?? 5 * 60_000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isFinite(this.leaseDurationMs) || this.leaseDurationMs <= 0) {
      throw new Error("leaseDurationMs must be a positive number");
    }
  }

  async claimNextQueuedProject() {
    const query = this.db.select({
      context: projects.context,
      demoRequestId: demoRequests.id,
      githubInstallationId: projects.githubInstallationId,
      attemptCount: projects.attemptCount,
      processingLeaseExpiresAt: projects.processingLeaseExpiresAt,
      processingLeaseToken: projects.processingLeaseToken,
      projectId: projects.id,
      repoUrl: projects.repoUrl,
      status: projects.status,
      supportingFiles: projects.supportingFiles,
    }) as SelectQueuedProjectQuery;
    const [row] = await query
      .from(projects)
      .innerJoin(demoRequests, eq(demoRequests.projectId, projects.id))
      .where(
        or(
          eq(projects.status, "queued"),
          and(
            eq(projects.status, "processing"),
            lte(projects.processingLeaseExpiresAt, this.now()),
          ),
        ),
      )
      .orderBy(asc(projects.createdAt))
      .limit(1);

    if (!row) {
      return undefined;
    }

    const projectId = readString(row, "projectId");
    const leaseToken = this.createLeaseToken();
    const now = this.now();
    const previousStatus = readOptionalString(row, "status") ?? "queued";
    const attemptCount =
      readOptionalNonNegativeInteger(row, "attemptCount") ?? 0;
    const updateQuery = this.db.update(projects) as UpdateReturningQuery;
    const [claimed] = await updateQuery
      .set({
        attemptCount: attemptCount + 1,
        lastError: null,
        processingLeaseExpiresAt: new Date(
          now.getTime() + this.leaseDurationMs,
        ),
        processingLeaseToken: leaseToken,
        processingStartedAt: now,
        status: "processing",
      })
      .where(
        previousStatus === "processing"
          ? and(
              eq(projects.id, projectId),
              eq(projects.status, "processing"),
              eq(
                projects.processingLeaseToken,
                readOptionalString(row, "processingLeaseToken") ?? "",
              ),
              lte(projects.processingLeaseExpiresAt, now),
            )
          : and(eq(projects.id, projectId), eq(projects.status, "queued")),
      )
      .returning({ id: projects.id });

    if (!claimed) {
      return undefined;
    }

    try {
      const githubInstallationId = readOptionalString(
        row,
        "githubInstallationId",
      );
      return {
        demoBrief: readDemoBriefFromProjectContext(row.context),
        demoRequestId: readString(row, "demoRequestId"),
        ...(githubInstallationId === undefined ? {} : { githubInstallationId }),
        leaseToken,
        normalizedSupportingDocuments: await this.loadSupportingDocuments(row),
        projectId,
        repoUrl: readString(row, "repoUrl"),
        workspaceId: projectId,
      };
    } catch (error) {
      await this.markProjectFailed({
        error:
          error instanceof Error
            ? error.message
            : "Supporting Document normalization failed",
        leaseToken,
        projectId,
      });
      return undefined;
    }
  }

  async markProjectCompleted(input: {
    generatedDemoUrl: string;
    leaseToken: string;
    projectId: string;
  }): Promise<void> {
    void input.generatedDemoUrl;
    await this.updateProjectStatus({
      lastError: null,
      leaseToken: input.leaseToken,
      projectId: input.projectId,
      status: "completed",
    });
  }

  async markProjectFailed(input: {
    error: string;
    leaseToken: string;
    projectId: string;
  }): Promise<void> {
    await this.updateProjectStatus({
      lastError: input.error,
      leaseToken: input.leaseToken,
      projectId: input.projectId,
      status: "failed",
    });
  }

  async renewProjectLease(input: {
    leaseToken: string;
    projectId: string;
  }): Promise<boolean> {
    const updateQuery = this.db.update(projects) as UpdateReturningQuery;
    const [project] = await updateQuery
      .set({
        processingLeaseExpiresAt: new Date(
          this.now().getTime() + this.leaseDurationMs,
        ),
      })
      .where(
        and(
          eq(projects.id, input.projectId),
          eq(projects.status, "processing"),
          eq(projects.processingLeaseToken, input.leaseToken),
        ),
      )
      .returning({ id: projects.id });
    return project !== undefined;
  }

  private async updateProjectStatus(input: {
    lastError: string | null;
    leaseToken: string;
    projectId: string;
    status: "completed" | "failed";
  }) {
    const updateQuery = this.db.update(projects) as UpdateReturningQuery;
    const [project] = await updateQuery
      .set({
        lastError: input.lastError,
        processingLeaseExpiresAt: null,
        processingLeaseToken: null,
        status: input.status,
      })
      .where(
        and(
          eq(projects.id, input.projectId),
          eq(projects.status, "processing"),
          eq(projects.processingLeaseToken, input.leaseToken),
        ),
      )
      .returning({ id: projects.id });

    if (!project) {
      throw new Error(
        `Failed to mark Project ${input.status}: processing lease is no longer owned`,
      );
    }
  }

  private async loadSupportingDocuments(
    row: Record<string, unknown>,
  ): Promise<NormalizedSupportingDocument[]> {
    const uploads = readQueuedSupportingDocumentUploads(row.supportingFiles);
    if (uploads.length === 0 || this.supportingDocumentLoader === undefined) {
      return [];
    }

    return this.supportingDocumentLoader.loadSupportingDocuments(uploads);
  }
}

function readDemoBriefFromProjectContext(value: unknown) {
  const context = readRecord(value, "Project context");
  const structuredContext = readRecord(
    context.structuredContext,
    "Project context.structuredContext",
  );
  const targetUsers = readOptionalString(structuredContext, "targetUsers");
  const productSummary = readOptionalString(
    structuredContext,
    "productSummary",
  );
  const demoLengthSeconds = readOptionalNumber(
    structuredContext,
    "requestedDurationSeconds",
  );

  return {
    ...(targetUsers ? { audience: targetUsers } : {}),
    ...(demoLengthSeconds === undefined ? {} : { demoLengthSeconds }),
    keyProductFeatures: splitFeatures(
      readOptionalString(structuredContext, "importantFeatures") ?? "",
    ),
    ...(productSummary ? { productSummary } : {}),
  };
}

function splitFeatures(value: string) {
  const features = value
    .split(/[\n,]/g)
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0);

  return features;
}

function readQueuedSupportingDocumentUploads(
  value: unknown,
): QueuedSupportingDocumentUpload[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry, index) => {
    const record = readRecord(
      typeof entry === "string" ? JSON.parse(entry) : entry,
      `supportingFiles[${index}]`,
    );

    return {
      fileName: readString(record, "fileName"),
      mimeType: readString(record, "mimeType"),
      r2Key: readString(record, "r2Key"),
      r2Url: readString(record, "r2Url"),
      sizeBytes: readNumber(record, "sizeBytes"),
    };
  });
}

function readNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }

  return value;
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

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${key} must be a string when provided`);
  }

  return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number when provided`);
  }
  return value;
}

function readOptionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
) {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${key} must be a non-negative integer when provided`);
  }
  return value as number;
}
