import { eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type {
  DemoRequestFinalVideoStore,
  LinkFinalVideoInput,
} from "../../pipeline/07-compositing/final-video-storage.interface";
import type {
  DemoRequestStatus,
  DemoRequestStatusStore,
} from "../../pipeline/final-output/demo-request-status.interface";
import { demoRequests } from "./schema";

type DemoRequestUpdateDatabase = {
  select(selection: {
    generatedDemoUrl: typeof demoRequests.generatedDemoUrl;
    status: typeof demoRequests.status;
  }): {
    from(table: typeof demoRequests): {
      where(condition: unknown): {
        limit(count: number): Promise<
          Array<{
            generatedDemoUrl: string | null;
            status: string;
          }>
        >;
      };
    };
  };
  update(table: typeof demoRequests): {
    set(values: { generatedDemoUrl: string; status: "completed" }): {
      where(condition: unknown): {
        returning(selection: { id: typeof demoRequests.id }): Promise<
          Array<{
            id: string;
          }>
        >;
      };
    };
  };
};

export class NeonDemoRequestFinalVideoStore
  implements DemoRequestFinalVideoStore, DemoRequestStatusStore
{
  private readonly db: DemoRequestUpdateDatabase;

  constructor(db: DemoRequestUpdateDatabase) {
    this.db = db;
  }

  async linkFinalVideo(input: LinkFinalVideoInput): Promise<void> {
    const [demoRequest] = await this.db
      .update(demoRequests)
      .set({
        generatedDemoUrl: input.generatedDemoUrl,
        status: "completed",
      })
      .where(eq(demoRequests.id, input.demoRequestId))
      .returning({ id: demoRequests.id });

    if (!demoRequest) {
      throw new Error("Failed to link final video to Demo Request");
    }
  }

  async readDemoRequestStatus(
    demoRequestId: string,
  ): Promise<DemoRequestStatus | undefined> {
    const [demoRequest] = await this.db
      .select({
        generatedDemoUrl: demoRequests.generatedDemoUrl,
        status: demoRequests.status,
      })
      .from(demoRequests)
      .where(eq(demoRequests.id, demoRequestId))
      .limit(1);

    if (!demoRequest) {
      return undefined;
    }

    if (demoRequest.status === "completed" && demoRequest.generatedDemoUrl) {
      return {
        generatedDemoUrl: demoRequest.generatedDemoUrl,
        status: "completed",
      };
    }

    if (demoRequest.status === "failed") {
      return { status: "failed" };
    }

    return { status: "processing" };
  }
}

export function createNeonDemoRequestFinalVideoStore(
  databaseUrl = readRequiredEnv("DATABASE_URL"),
): NeonDemoRequestFinalVideoStore {
  const client = postgres(databaseUrl, { max: 5 });
  return new NeonDemoRequestFinalVideoStore(
    drizzle(client) as PostgresJsDatabase<Record<string, never>>,
  );
}

function readRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}
