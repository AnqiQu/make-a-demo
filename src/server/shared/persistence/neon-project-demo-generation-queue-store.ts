import { and, asc, eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { ProjectDemoGenerationQueueStore } from "../pipeline-runner/project-demo-generation-queue";
import { demoRequests, projects } from "./schema";

type ProjectQueueDatabase = {
  select(selection: unknown): unknown;
  update(table: unknown): unknown;
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

  constructor(db: ProjectQueueDatabase) {
    this.db = db;
  }

  async claimNextQueuedProject() {
    const query = this.db.select({
      context: projects.context,
      demoRequestId: demoRequests.id,
      projectId: projects.id,
      repoUrl: projects.repoUrl,
    }) as SelectQueuedProjectQuery;
    const [row] = await query
      .from(projects)
      .innerJoin(demoRequests, eq(demoRequests.projectId, projects.id))
      .where(eq(projects.status, "queued"))
      .orderBy(asc(projects.createdAt))
      .limit(1);

    if (!row) {
      return undefined;
    }

    const projectId = readString(row, "projectId");
    const updateQuery = this.db.update(projects) as UpdateReturningQuery;
    const [claimed] = await updateQuery
      .set({ status: "processing" })
      .where(and(eq(projects.id, projectId), eq(projects.status, "queued")))
      .returning({ id: projects.id });

    if (!claimed) {
      return undefined;
    }

    return {
      demoBrief: readDemoBriefFromProjectContext(row.context),
      demoRequestId: readString(row, "demoRequestId"),
      normalizedSupportingDocuments: [],
      projectId,
      repoUrl: readString(row, "repoUrl"),
      workspaceId: projectId,
    };
  }

  async markProjectCompleted(input: {
    generatedDemoUrl: string;
    projectId: string;
  }): Promise<void> {
    void input.generatedDemoUrl;
    await this.updateProjectStatus(input.projectId, "completed");
  }

  async markProjectFailed(input: {
    error: string;
    projectId: string;
  }): Promise<void> {
    void input.error;
    await this.updateProjectStatus(input.projectId, "failed");
  }

  private async updateProjectStatus(
    projectId: string,
    status: "completed" | "failed",
  ) {
    const updateQuery = this.db.update(projects) as UpdateReturningQuery;
    const [project] = await updateQuery
      .set({ status })
      .where(eq(projects.id, projectId))
      .returning({ id: projects.id });

    if (!project) {
      throw new Error(`Failed to mark Project ${status}`);
    }
  }
}

export function createNeonProjectDemoGenerationQueueStore(
  databaseUrl = readRequiredEnv("DATABASE_URL"),
): NeonProjectDemoGenerationQueueStore {
  const client = postgres(databaseUrl, { max: 5 });
  return new NeonProjectDemoGenerationQueueStore(
    drizzle(client) as PostgresJsDatabase<Record<string, never>>,
  );
}

function readDemoBriefFromProjectContext(value: unknown) {
  const context = readRecord(value, "Project context");
  const structuredContext = readRecord(
    context.structuredContext,
    "Project context.structuredContext",
  );
  const targetUsers = readOptionalString(structuredContext, "targetUsers");

  return {
    ...(targetUsers ? { audience: targetUsers } : {}),
    keyProductFeatures: splitFeatures(
      readString(structuredContext, "importantFeatures"),
    ),
  };
}

function splitFeatures(value: string) {
  const features = value
    .split(/[\n,]/g)
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0);

  return features.length > 0 ? features : [value.trim()];
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

function readRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}
