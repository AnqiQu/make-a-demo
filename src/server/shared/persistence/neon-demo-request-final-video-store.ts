import { eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type {
  DemoRequestFinalVideoStore,
  LinkFinalVideoInput,
} from "../../pipeline/07-compositing/final-video-storage.interface";
import { demoRequests } from "./schema";

type DemoRequestUpdateDatabase = {
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
  implements DemoRequestFinalVideoStore
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
