import { createHash } from "node:crypto";
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
  previousManifest?: ExternalResourceManifest;
  workspace: AgentHarnessWorkspace;
}) {
  if (input.manifest === undefined) return;
  const manifest = readExternalResourceManifest(input.manifest);
  if (manifest.entries.length === 0) return;
  if (input.workspace.uploadSubmittedCodeFiles === undefined) {
    throw new Error("Submitted-code resource replay upload is unavailable.");
  }
  const previousPaths = new Set(
    input.previousManifest === undefined
      ? []
      : readExternalResourceManifest(input.previousManifest).entries.map(
          (entry) => entry.relativePath,
        ),
  );
  const uniqueEntries = [
    ...new Map(
      manifest.entries.map((entry) => [entry.relativePath, entry]),
    ).values(),
  ];
  await verifyExternalResourceCache({
    directory: input.directory,
    manifest,
  });
  await mkdir(input.directory, { recursive: true });
  const manifestPath = join(input.directory, "external-resource-manifest.json");
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestContents);
  await executeSubmittedCode(
    input.workspace,
    `mkdir -p ${shellQuote(`${externalResourceReplayRoot}/resources`)}`,
  );
  await input.workspace.uploadSubmittedCodeFiles([
    {
      destinationPath: `${externalResourceReplayRoot}/external-resource-manifest.json`,
      sourcePath: manifestPath,
    },
    ...uniqueEntries
      .filter((entry) => !previousPaths.has(entry.relativePath))
      .map((entry) => ({
        destinationPath: `${externalResourceReplayRoot}/${entry.relativePath}`,
        sourcePath: join(input.directory, entry.relativePath),
      })),
  ]);
  const checksums = [
    `${createHash("sha256").update(manifestContents).digest("hex")}  external-resource-manifest.json`,
    ...uniqueEntries.map(
      (entry) =>
        `${entry.sha256.slice("sha256:".length)}  ${entry.relativePath}`,
    ),
  ].join("\n");
  const encodedChecksums = Buffer.from(`${checksums}\n`).toString("base64");
  const verification = await executeSubmittedCode(
    input.workspace,
    `cd ${shellQuote(externalResourceReplayRoot)} && printf %s ${shellQuote(encodedChecksums)} | base64 -d | sha256sum -c -`,
  );
  if (verification.exitCode !== 0) {
    throw new Error(
      `Submitted-code resource cache integrity failed after upload: ${verification.stderr || verification.stdout}`,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
