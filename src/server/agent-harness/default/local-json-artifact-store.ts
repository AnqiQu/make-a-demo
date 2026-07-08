import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type JsonArtifactLogger = (
  event: string,
  fields?: Record<string, unknown>,
) => Promise<void>;

export class LocalJsonArtifactStore {
  constructor(
    private readonly artifactDirectory: string,
    private readonly log: JsonArtifactLogger,
  ) {}

  async writeJson(path: string, value: unknown): Promise<void> {
    const localPath = this.resolveArtifactPath(path);
    await writeJsonFile(localPath, value);
    await this.log("artifact.written", { artifactPath: path, localPath });
  }

  resolveArtifactPath(path: string): string {
    const normalized = path.replace(/^\/+/, "");
    return join(this.artifactDirectory, normalized);
  }
}

export async function writeJsonFile(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
