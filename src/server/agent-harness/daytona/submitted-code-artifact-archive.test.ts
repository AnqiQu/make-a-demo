import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { uploadSubmittedCodeArchive } from "./submitted-code-artifact-archive";

describe("submitted-code artifact archives", () => {
  it("rejects archive entries that escape the declared directory", async () => {
    const localDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-artifact-archive-test-"),
    );
    let uploadCalled = false;

    await expect(
      uploadSubmittedCodeArchive({
        archiveName: "capture-inputs.tgz",
        entries: ["../secret.txt"],
        localDirectory,
        remoteDirectory: "/workspace/.makeademo/capture",
        workspace: {
          async destroy() {},
          async execute() {
            return { exitCode: 0, stderr: "", stdout: "" };
          },
          async executeSubmittedCode() {
            return { exitCode: 0, stderr: "", stdout: "" };
          },
          async uploadSubmittedCodeFiles() {
            uploadCalled = true;
          },
        },
      }),
    ).rejects.toThrow("Unsafe submitted-code archive entry: ../secret.txt");

    expect(uploadCalled).toBe(false);
  });
});
