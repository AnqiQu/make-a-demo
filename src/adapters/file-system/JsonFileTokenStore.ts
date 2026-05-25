import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type {
  CodexTokenRecord,
  TokenStore,
} from "../../core/auth/TokenStore.interface";
import { AgentError } from "../../core/errors/AgentError";

const tokenRecordSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  account: z
    .object({
      email: z.string().nullable(),
      planType: z.string().nullable(),
    })
    .nullable(),
});

/** Project-local JSON token store used by the template CLI. */
export class JsonFileTokenStore implements TokenStore {
  readonly #filePath: string;

  constructor(options: { readonly filePath: string }) {
    this.#filePath = options.filePath;
  }

  async read(): Promise<CodexTokenRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (cause) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "ENOENT"
      ) {
        return null;
      }
      throw cause;
    }

    try {
      return tokenRecordSchema.parse(JSON.parse(raw));
    } catch (cause) {
      throw new AgentError({
        code: "auth_failed",
        message: `Invalid token store at ${this.#filePath}.`,
        cause,
      });
    }
  }

  async write(record: CodexTokenRecord): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(
      this.#filePath,
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }

  async clear(): Promise<void> {
    await rm(this.#filePath, { force: true });
  }
}
