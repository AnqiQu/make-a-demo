import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { externalResourceManifestVersion } from "../../shared/external-resources/external-resource-manifest.schema";
import { uploadSubmittedCodeExternalResourceCache } from "./submitted-code-external-resource-cache";
import type { AgentHarnessWorkspace } from "./workspace.interface";

describe("uploadSubmittedCodeExternalResourceCache", () => {
  it("verifies uploaded replay bytes inside the submitted-code sandbox", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-cache-upload-"));
    const body = Buffer.from("original-logo");
    const digest = createHash("sha256").update(body).digest("hex");
    const relativePath = `resources/${digest}`;
    await mkdir(join(directory, "resources"), { recursive: true });
    await writeFile(join(directory, relativePath), body);
    const commands: string[] = [];
    const workspace: AgentHarnessWorkspace = {
      async destroy() {},
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async executeSubmittedCode(command) {
        commands.push(command);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async uploadSubmittedCodeFiles() {},
    };

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

      expect(commands).toHaveLength(2);
      expect(commands[1]).toContain("sha256sum -c");
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
    const workspace: AgentHarnessWorkspace = {
      async destroy() {},
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async executeSubmittedCode() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async uploadSubmittedCodeFiles(files) {
        uploadedDestinations.push(...files.map((file) => file.destinationPath));
      },
    };
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

      expect(uploadedDestinations).toContain(
        "/workspace/.makeademo/external-resources/external-resource-manifest.json",
      );
      expect(uploadedDestinations).toContain(
        `/workspace/.makeademo/external-resources/resources/${newDigest}`,
      );
      expect(
        uploadedDestinations.filter((destination) =>
          destination.endsWith(`/resources/${newDigest}`),
        ),
      ).toHaveLength(1);
      expect(uploadedDestinations).not.toContain(
        `/workspace/.makeademo/external-resources/resources/${oldDigest}`,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
