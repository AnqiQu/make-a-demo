import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

  it("removes local and partial remote archives when upload fails", async () => {
    const localDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-artifact-archive-test-"),
    );
    const failure = new Error("upload failed");
    const submittedCommands: string[] = [];
    await writeFile(join(localDirectory, "input.txt"), "input");

    try {
      await expect(
        uploadSubmittedCodeArchive({
          archiveName: "capture-inputs.tgz",
          entries: ["input.txt"],
          localDirectory,
          remoteDirectory: "/workspace/.makeademo/capture",
          workspace: {
            async destroy() {},
            async execute() {
              return { exitCode: 0, stderr: "", stdout: "" };
            },
            async executeSubmittedCode(command) {
              submittedCommands.push(command);
              return { exitCode: 0, stderr: "", stdout: "" };
            },
            async uploadSubmittedCodeFiles() {
              throw failure;
            },
          },
        }),
      ).rejects.toBe(failure);

      expect(await readdir(localDirectory)).toEqual(["input.txt"]);
      expect(submittedCommands.at(-1)).toBe(
        "rm -f '/workspace/.makeademo/capture/capture-inputs.tgz'",
      );
    } finally {
      await rm(localDirectory, { force: true, recursive: true });
    }
  });
});
