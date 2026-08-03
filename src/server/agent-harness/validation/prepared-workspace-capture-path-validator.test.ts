import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
                '[makeademo:action] {"elapsedMs":12,"event":"started","label":"expect.toBeVisible(locator(main))","sceneId":"scene-main"}',
                '[makeademo:action] {"elapsedMs":18,"event":"succeeded","label":"expect.toBeVisible(locator(main))","sceneId":"scene-main"}',
                '[makeademo:network-blocked] {"direction":"outbound","host":"analytics.example.com","method":"POST","phase":"runtime","resourceType":"fetch","url":"https://analytics.example.com/events"}',
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
      sceneIds: ["scene-main"],
      workspace,
    });

    expect(result.status).toBe("succeeded");
    expect(result.warnings).toEqual([
      "Runtime Network Lockdown suppressed 1 uncached external request(s).",
    ]);
    expect(genericUploadCalled).toBe(false);
    expect(uploadedDestinations).toEqual([
      expect.stringMatching(/capture-inputs\.tgz$/),
    ]);
    expect(submittedCommands.map(({ command }) => command).join("\n")).toMatch(
      /tar -xzf .*capture-inputs\.tgz.*capture-path-validation-runs/s,
    );
    expect(
      submittedCommands.map(({ command }) => command).join("\n"),
    ).not.toContain("ffmpeg");
    expect(
      await readFile(join(localRunDirectory, "demo-script.ts"), "utf8"),
    ).not.toContain("recordVideo");
    expect(
      submittedCommands.find(({ command }) => command.includes("bun ")),
    ).toMatchObject({
      command: expect.stringContaining("timeout -k 10s 210s"),
      timeoutMs: 220_000,
    });
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

  it("fails a successful process that did not prove a visible assertion in every declared Scene", async () => {
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
      sceneIds: ["scene-main"],
      workspace,
    });

    expect(result).toMatchObject({
      failureClassification: "script contract failure",
      failureReason:
        "Capture Script Protocol Violation: Scene scene-main did not emit a successful visible Playwright assertion.",
      status: "failed",
    });
  });

  it("preserves the generated browser failure as repair evidence", async () => {
    const localRunDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-capture-validation-test-"),
    );
    const validationEvents: string[] = [];
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
              stderr: "",
              stdout: [
                '[makeademo:validation] script started {"baseUrl":"http://127.0.0.1:3000"}',
                '[makeademo:scene] {"elapsedMs":1,"event":"started","sceneId":"scene-main"}',
                '[makeademo:step] {"elapsedMs":2,"event":"started","sceneId":"scene-main","stepId":"click-dashboard"}',
                '[makeademo:action] {"elapsedMs":3,"event":"started","label":"locator.click(getByRole(link))","sceneId":"scene-main"}',
                '[makeademo:action] {"elapsedMs":10003,"event":"failed","label":"locator.click(getByRole(link))","message":"locator click timed out","sceneId":"scene-main"}',
                '[makeademo:step] {"elapsedMs":10004,"event":"failed","message":"locator click timed out","sceneId":"scene-main","stepId":"click-dashboard"}',
                '[makeademo:scene] {"elapsedMs":10005,"event":"failed","message":"locator click timed out","sceneId":"scene-main"}',
                '[makeademo:validation] script failed {"message":"locator click timed out","screenshotPath":"/workspace/.makeademo/capture-path-validation-runs/run/makeademo-validation-failure.png","url":"http://127.0.0.1:3000/"}',
              ].join("\n"),
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
        "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl); });",
        "await scene('scene-main', async ({ page, expect }) => { await expect(page.locator('main')).toBeVisible(); });",
      ].join("\n"),
      localRunDirectory,
      sceneIds: ["scene-main"],
      workspace,
    });

    expect(result).toMatchObject({
      failureClassification: "locator failure",
      failureReason: expect.stringContaining("click-dashboard"),
      status: "failed",
    });
    expect(result.logs.join("\n")).toContain("locator click timed out");
    expect(await readFile(result.stdoutPath, "utf8")).toContain(
      "[makeademo:validation] script failed",
    );
    expect(validationEvents).toContain(
      "capture-path-validation.script-execution.failed",
    );
    expect(validationEvents).not.toContain(
      "capture-path-validation.script-execution.succeeded",
    );
    expect(result.screenshotArtifactId).toContain(
      "makeademo-validation-failure.png",
    );
    await expect(
      readFile(result.screenshotArtifactId as string, "utf8"),
    ).resolves.toBe("png");
  });

  it("downloads the backend-owned screenshot path, not the one the script reported", async () => {
    const localRunDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-capture-validation-test-"),
    );
    const requestedSources: string[] = [];
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
              stderr: "",
              stdout: [
                '[makeademo:validation] script started {"baseUrl":"http://127.0.0.1:3000"}',
                '[makeademo:scene] {"elapsedMs":1,"event":"started","sceneId":"scene-main"}',
                '[makeademo:action] {"elapsedMs":3,"event":"started","label":"locator.click(getByRole(link))","sceneId":"scene-main"}',
                '[makeademo:action] {"elapsedMs":10003,"event":"failed","label":"locator.click(getByRole(link))","message":"locator click timed out","sceneId":"scene-main"}',
                '[makeademo:scene] {"elapsedMs":10005,"event":"failed","message":"locator click timed out","sceneId":"scene-main"}',
                '[makeademo:validation] script failed {"message":"locator click timed out","screenshotPath":"/workspace/repo/.env","url":"http://127.0.0.1:3000/"}',
              ].join("\n"),
            };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async downloadSubmittedCodeFiles(files) {
          requestedSources.push(...files.map((file) => file.sourcePath));
          await Promise.all(
            files.map((file) => writeFile(file.destinationPath, "png")),
          );
        },
        async uploadSubmittedCodeFiles() {},
      },
    };

    await validatePreparedWorkspaceCapturePath({
      baseUrl: "http://127.0.0.1:3000",
      demoPlaywrightScript: [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await scene('scene-main', async ({ page, expect }) => { await expect(page.locator('main')).toBeVisible(); });",
      ].join("\n"),
      localRunDirectory,
      sceneIds: ["scene-main"],
      workspace,
    });

    expect(requestedSources).toEqual([
      `/workspace/.makeademo/capture-path-validation-runs/${basename(localRunDirectory)}/makeademo-validation-failure.png`,
    ]);
  });

  it("reports an off-camera setup navigation timeout instead of a protocol failure", async () => {
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
              stderr: "",
              stdout: [
                '[makeademo:validation] script started {"baseUrl":"http://127.0.0.1:3000"}',
                '[makeademo:action] {"elapsedMs":1,"event":"started","label":"page.goto(http://127.0.0.1:3000)","sceneId":"setup","timeoutMs":10000}',
                '[makeademo:action] {"elapsedMs":10001,"event":"failed","label":"page.goto(http://127.0.0.1:3000)","message":"goto: Timeout 10000ms exceeded","sceneId":"setup","timeoutMs":10000}',
                '[makeademo:validation] script failed {"message":"goto: Timeout 10000ms exceeded","url":"http://127.0.0.1:3000/login"}',
              ].join("\n"),
            };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
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
      sceneIds: ["scene-main"],
      workspace,
    });

    expect(result).toMatchObject({
      failureClassification: "start failure",
      failureReason: expect.stringContaining("page.goto"),
      status: "failed",
    });
    expect(result.failureReason).not.toContain(
      "successful capture run must emit",
    );
  });

  it("includes raw process diagnostics when execution fails before protocol markers", async () => {
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
              stderr: "SyntaxError: Unexpected token at demo-script.ts:17",
              stdout: "",
            };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
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
      sceneIds: ["scene-main"],
      workspace,
    });

    expect(result).toMatchObject({
      failureReason: expect.stringContaining(
        "SyntaxError: Unexpected token at demo-script.ts:17",
      ),
      status: "failed",
    });
  });
});
