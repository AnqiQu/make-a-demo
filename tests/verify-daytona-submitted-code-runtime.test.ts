import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_SUBMITTED_CODE_BUN_VERSION,
  EXPECTED_SUBMITTED_CODE_PLAYWRIGHT_VERSION,
  verifyDaytonaSubmittedCodeRuntime,
} from "../scripts/verify-daytona-submitted-code-runtime";
import type { AgentHarnessWorkspace } from "../src/server/agent-harness/daytona/workspace.interface";

describe("verifyDaytonaSubmittedCodeRuntime", () => {
  it("pins the local browser toolchain to the submitted-code runtime", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      devDependencies: Record<string, string>;
      packageManager?: string;
    };

    expect(packageJson.packageManager).toBe("bun@1.3.14");
    expect(packageJson.devDependencies["@playwright/test"]).toBe("1.60.0");
    expect(packageJson.devDependencies["bun-types"]).toBe("1.3.14");
  });

  it("uploads one canonical SDK smoke bundle and verifies exact runtime versions", async () => {
    const commands: string[] = [];
    let uploadedSmokeScript = "";
    const uploads: Array<
      Array<{ destinationPath: string; sourcePath: string }>
    > = [];
    const workspace: AgentHarnessWorkspace = {
      async destroy() {},
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async executeSubmittedCode(command) {
        commands.push(command);
        if (command.includes("makeademo_capture_sdk_smoke=passed")) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: [
              `makeademo_bun_version=${EXPECTED_SUBMITTED_CODE_BUN_VERSION}`,
              `makeademo_playwright_version=${EXPECTED_SUBMITTED_CODE_PLAYWRIGHT_VERSION}`,
              '[makeademo:action] {"event":"succeeded","label":"expect.toBeVisible(locator(body))"}',
              '[makeademo:step] {"event":"succeeded","stepId":"main-heading-visible","sceneId":"scene_main"}',
              '[makeademo:scene] {"event":"succeeded","sceneId":"scene_main"}',
              "makeademo_capture_sdk_smoke=passed",
            ].join("\n"),
          };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async uploadSubmittedCodeFiles(files) {
        uploads.push(files);
        const archive = files[0];
        if (archive !== undefined) {
          const extracted = spawnSync(
            "tar",
            ["-xOzf", archive.sourcePath, "demo-script.ts"],
            { encoding: "utf8" },
          );
          if (extracted.status !== 0) {
            throw new Error(extracted.stderr);
          }
          uploadedSmokeScript = extracted.stdout;
        }
      },
    };

    await verifyDaytonaSubmittedCodeRuntime(workspace);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toHaveLength(1);
    const verificationCommand = commands.find((command) =>
      command.includes("makeademo_capture_sdk_smoke=passed"),
    );
    expect(verificationCommand).toContain(
      `test \"$makeademo_bun_version\" = '${EXPECTED_SUBMITTED_CODE_BUN_VERSION}'`,
    );
    expect(verificationCommand).toContain("@playwright/test/package.json");
    expect(verificationCommand).toContain(
      EXPECTED_SUBMITTED_CODE_PLAYWRIGHT_VERSION,
    );
    expect(verificationCommand).toContain("bun 'demo-script.ts'");
    expect(EXPECTED_SUBMITTED_CODE_BUN_VERSION).toBe("1.3.14");
    expect(uploadedSmokeScript).toContain(
      'await step("main-heading-visible", async () => {',
    );
  });

  it("requires evidence that the backend-compiled action step executed", async () => {
    const workspace: AgentHarnessWorkspace = {
      async destroy() {},
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async executeSubmittedCode(command) {
        if (command.includes("makeademo_capture_sdk_smoke=passed")) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: [
              `makeademo_bun_version=${EXPECTED_SUBMITTED_CODE_BUN_VERSION}`,
              `makeademo_playwright_version=${EXPECTED_SUBMITTED_CODE_PLAYWRIGHT_VERSION}`,
              '[makeademo:action] {"event":"succeeded","label":"expect.toBeVisible(locator(body))"}',
              '[makeademo:scene] {"event":"succeeded","sceneId":"scene_main"}',
              "makeademo_capture_sdk_smoke=passed",
            ].join("\n"),
          };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async uploadSubmittedCodeFiles() {},
    };

    await expect(verifyDaytonaSubmittedCodeRuntime(workspace)).rejects.toThrow(
      "backend-compiled action step",
    );
  });
});
