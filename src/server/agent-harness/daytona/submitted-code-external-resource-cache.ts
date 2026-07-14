import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { externalResourceReplayRoot } from "../../shared/external-resources/browser-runtime-network-policy";
import { verifyExternalResourceCache } from "../../shared/external-resources/external-resource-cache";
import {
  type ExternalResourceManifest,
  readExternalResourceManifest,
} from "../../shared/external-resources/external-resource-manifest.schema";
import { executeSubmittedCode } from "./submitted-code-execution";
import type { AgentHarnessWorkspace } from "./workspace.interface";

/** Uploads a verified resource cache into the sealed submitted-code sandbox. */
export async function uploadSubmittedCodeExternalResourceCache(input: {
  directory: string;
  manifest?: ExternalResourceManifest;
  workspace: AgentHarnessWorkspace;
}) {
  if (input.manifest === undefined) return;
  if (input.workspace.uploadSubmittedCodeFiles === undefined) {
    throw new Error("Submitted-code resource replay upload is unavailable.");
  }
  const manifest = readExternalResourceManifest(input.manifest);
  await verifyExternalResourceCache({
    directory: input.directory,
    manifest,
  });
  await mkdir(input.directory, { recursive: true });
  const manifestPath = join(input.directory, "external-resource-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await executeSubmittedCode(
    input.workspace,
    `mkdir -p ${shellQuote(`${externalResourceReplayRoot}/resources`)}`,
  );
  await input.workspace.uploadSubmittedCodeFiles([
    {
      destinationPath: `${externalResourceReplayRoot}/external-resource-manifest.json`,
      sourcePath: manifestPath,
    },
    ...manifest.entries.map((entry) => ({
      destinationPath: `${externalResourceReplayRoot}/${entry.relativePath}`,
      sourcePath: join(input.directory, entry.relativePath),
    })),
  ]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
