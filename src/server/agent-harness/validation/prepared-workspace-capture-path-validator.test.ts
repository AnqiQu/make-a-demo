import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentHarnessWorkspaceHandle } from "../daytona/workspace.interface";
import { validatePreparedWorkspaceCapturePath } from "./prepared-workspace-capture-path-validator";

describe("validatePreparedWorkspaceCapturePath", () => {
  it("dry-runs the Capture SDK script without recording footage", async () => {
    const localRunDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-capture-validation-test-"),
    );
    const submittedCommands: Array<{
      command: string;
      timeoutMs?: number;
    }> = [];
    const uploadedDestinations: string[] = [];
    const validationEvents: string[] = [];
    let genericUploadCalled = false;
    const workspace: AgentHarnessWorkspaceHandle = {
      async destroy() {},
      id: "agent_sandbox",
      workspace: {
        async destroy() {},
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async executeSubmittedCode(command, options) {
          submittedCommands.push({
            command,
            ...(options?.timeoutMs === undefined
              ? {}
              : { timeoutMs: options.timeoutMs }),
          });
          if (command.includes("bun ")) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: [
                '[makeademo:validation] script started {"baseUrl":"http://127.0.0.1:3000"}',
                '[makeademo:scene] {"elapsedMs":10,"event":"started","sceneId":"scene-main"}',
                '[makeademo:scene] {"elapsedMs":20,"event":"succeeded","sceneId":"scene-main"}',
                '[makeademo:validation] script succeeded {"title":"Demo","url":"http://127.0.0.1:3000/"}',
              ].join("\n"),
            };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async uploadFiles() {
          genericUploadCalled = true;
        },
        async uploadSubmittedCodeFiles(files) {
          uploadedDestinations.push(
            ...files.map((file) => file.destinationPath),
          );
        },
        async writeSandboxLog(entry) {
          if (typeof entry.event === "string") {
            validationEvents.push(entry.event);
          }
        },
      },
    };

    const result = await validatePreparedWorkspaceCapturePath({
      baseUrl: "http://127.0.0.1:3000",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await setup(async ({ page, baseUrl, expect }) => { await page.goto(baseUrl); await expect(page.locator('body')).toBeVisible(); });",
        "await scene('scene-main', async ({ page, expect }) => { await expect(page.locator('body')).toBeVisible(); });",
      ].join("\n"),
      localRunDirectory,
      workspace,
    });

    expect(result.status).toBe("succeeded");
    expect(genericUploadCalled).toBe(false);
    expect(uploadedDestinations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("makeademo-capture-sdk.js"),
        expect.stringContaining("demo-script.ts"),
      ]),
    );
    expect(
      submittedCommands.map(({ command }) => command).join("\n"),
    ).not.toContain("ffmpeg");
    expect(
      await readFile(join(localRunDirectory, "demo-script.ts"), "utf8"),
    ).not.toContain("recordVideo");
    expect(
      submittedCommands.find(({ command }) => command.includes("bun ")),
    ).toMatchObject({ timeoutMs: 130_000 });
    expect(await readFile(result.stdoutPath as string, "utf8")).toContain(
      "[makeademo:validation] script succeeded",
    );
    expect(validationEvents).toEqual(
      expect.arrayContaining([
        "capture-path-validation.artifact-upload.started",
        "capture-path-validation.artifact-upload.succeeded",
        "capture-path-validation.script-execution.started",
        "capture-path-validation.script-execution.succeeded",
      ]),
    );
  });

  it("preserves the generated browser failure as repair evidence", async () => {
    const localRunDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-capture-validation-test-"),
    );
    const workspace: AgentHarnessWorkspaceHandle = {
      async destroy() {},
      id: "agent_sandbox",
      workspace: {
        async destroy() {},
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async executeSubmittedCode(command) {
          if (command.includes("bun ")) {
            return {
              exitCode: 1,
              stderr:
                '[makeademo:validation] script failed {"message":"locator click timed out","screenshotPath":"/workspace/.makeademo/capture-path-validation-runs/run/makeademo-validation-failure.png","url":"http://127.0.0.1:3000/"}',
              stdout:
                '[makeademo:validation] script started {"baseUrl":"http://127.0.0.1:3000"}',
            };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async downloadSubmittedCodeFiles(files) {
          await Promise.all(
            files.map((file) => writeFile(file.destinationPath, "png")),
          );
        },
        async uploadSubmittedCodeFiles() {},
      },
    };

    const result = await validatePreparedWorkspaceCapturePath({
      baseUrl: "http://127.0.0.1:3000",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl); });",
        "await scene('scene-main', async ({ page, expect }) => { await expect(page.locator('main')).toBeVisible(); });",
      ].join("\n"),
      localRunDirectory,
      workspace,
    });

    expect(result).toMatchObject({
      failureReason: "locator click timed out",
      status: "failed",
    });
    expect(result.logs.join("\n")).toContain("locator click timed out");
    expect(await readFile(result.stderrPath, "utf8")).toContain(
      "[makeademo:validation] script failed",
    );
    expect(result.screenshotArtifactId).toContain(
      "makeademo-validation-failure.png",
    );
    await expect(
      readFile(result.screenshotArtifactId as string, "utf8"),
    ).resolves.toBe("png");
  });
});
