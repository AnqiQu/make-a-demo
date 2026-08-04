import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { externalResourceManifestVersion } from "../../shared/external-resources/external-resource-manifest.schema";
import { uploadSubmittedCodeExternalResourceCache } from "./submitted-code-external-resource-cache";
import { createFakeAgentHarnessWorkspace } from "./workspace.test-helpers";

const execFileAsync = promisify(execFile);

describe("uploadSubmittedCodeExternalResourceCache", () => {
  it("verifies uploaded replay bytes inside the submitted-code sandbox", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-cache-upload-"));
    const body = Buffer.from("original-logo");
    const digest = createHash("sha256").update(body).digest("hex");
    const relativePath = `resources/${digest}`;
    await mkdir(join(directory, "resources"), { recursive: true });
    await writeFile(join(directory, relativePath), body);
    const commands: string[] = [];
    const workspace = createFakeAgentHarnessWorkspace({
      async executeSubmittedCode(command) {
        commands.push(command);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    });

    try {
      await uploadSubmittedCodeExternalResourceCache({
        directory,
        manifest: {
          entries: [
            {
              contentType: "image/svg+xml",
              headers: {},
              relativePath,
              sha256: `sha256:${digest}`,
              sizeBytes: body.byteLength,
              status: 200,
              url: "https://assets.example.com/logo.svg",
            },
          ],
          version: externalResourceManifestVersion,
        },
        workspace,
      });

      expect(commands).toContainEqual(expect.stringContaining("tar -xzf"));
      expect(commands.at(-1)).toContain("sha256sum -c");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("uploads only resource bodies added since the previous manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-cache-upload-"));
    const oldBody = Buffer.from("old-logo");
    const newBody = Buffer.from("new-logo");
    const oldDigest = createHash("sha256").update(oldBody).digest("hex");
    const newDigest = createHash("sha256").update(newBody).digest("hex");
    await mkdir(join(directory, "resources"), { recursive: true });
    await Promise.all([
      writeFile(join(directory, "resources", oldDigest), oldBody),
      writeFile(join(directory, "resources", newDigest), newBody),
    ]);
    const uploadedDestinations: string[] = [];
    let uploadedArchiveEntries: string[] = [];
    const workspace = createFakeAgentHarnessWorkspace({
      async uploadSubmittedCodeFiles(files) {
        uploadedDestinations.push(...files.map((file) => file.destinationPath));
        const archive = files.length === 1 ? files[0] : undefined;
        if (archive?.sourcePath.endsWith(".tgz")) {
          const { stdout } = await execFileAsync("tar", [
            "-tzf",
            archive.sourcePath,
          ]);
          uploadedArchiveEntries = stdout.trim().split("\n");
        }
      },
    });
    const oldEntry = {
      contentType: "image/svg+xml",
      headers: {},
      relativePath: `resources/${oldDigest}`,
      sha256: `sha256:${oldDigest}` as const,
      sizeBytes: oldBody.byteLength,
      status: 200,
      url: "https://assets.example.com/old.svg",
    };
    const newEntry = {
      contentType: "image/svg+xml",
      headers: {},
      relativePath: `resources/${newDigest}`,
      sha256: `sha256:${newDigest}` as const,
      sizeBytes: newBody.byteLength,
      status: 200,
      url: "https://assets.example.com/new.svg",
    };

    try {
      await uploadSubmittedCodeExternalResourceCache({
        directory,
        manifest: {
          entries: [
            oldEntry,
            newEntry,
            {
              ...newEntry,
              url: "https://cdn.example.com/new.svg",
            },
          ],
          version: externalResourceManifestVersion,
        },
        previousManifest: {
          entries: [oldEntry],
          version: externalResourceManifestVersion,
        },
        workspace,
      });

      expect(uploadedDestinations).toEqual([
        "/workspace/.makeademo/external-resources/external-resource-cache.tgz",
      ]);
      expect(uploadedArchiveEntries.sort()).toEqual([
        "external-resource-manifest.json",
        `resources/${newDigest}`,
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
