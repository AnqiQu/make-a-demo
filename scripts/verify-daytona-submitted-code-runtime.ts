import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadSubmittedCodeArchive } from "../src/server/agent-harness/daytona/submitted-code-artifact-archive";
import { executeSubmittedCode } from "../src/server/agent-harness/daytona/submitted-code-execution";
import type { AgentHarnessWorkspace } from "../src/server/agent-harness/daytona/workspace.interface";
import { compileBrowserActionPlan } from "../src/server/pipeline/06-footage-capture/browser-action-plan";
import {
  BUN_RUNTIME_VERSION,
  PLAYWRIGHT_RUNTIME_VERSION,
} from "../src/server/pipeline/06-footage-capture/capture-contract-versions";
import { writeGeneratedCaptureSdkHarness } from "../src/server/pipeline/06-footage-capture/capture-sdk-contract";
import { prepareStylizedPlaywrightScript } from "../src/server/pipeline/06-footage-capture/stylized-playwright-script";

export const EXPECTED_SUBMITTED_CODE_BUN_VERSION = BUN_RUNTIME_VERSION;
export const EXPECTED_SUBMITTED_CODE_PLAYWRIGHT_VERSION =
  PLAYWRIGHT_RUNTIME_VERSION;

const remoteSmokeDirectory = "/tmp/makeademo-capture-sdk-smoke";

/**
 * Proves that the submitted-code image has the pinned browser runtime and can
 * execute the same generated Capture SDK assertion used by the pipeline.
 */
export async function verifyDaytonaSubmittedCodeRuntime(
  workspace: AgentHarnessWorkspace,
): Promise<void> {
  const localDirectory = await mkdtemp(
    join(tmpdir(), "makeademo-daytona-sdk-smoke-"),
  );
  try {
    await writeGeneratedCaptureSdkHarness(localDirectory);
    await writeFile(
      join(localDirectory, "demo-script.ts"),
      prepareStylizedPlaywrightScript(
        compileBrowserActionPlan({
          scenes: [
            {
              actions: [
                {
                  id: "main-heading-visible",
                  locator: {
                    name: "Main content",
                    role: "heading",
                    strategy: "role",
                  },
                  type: "assert-visible",
                },
              ],
              id: "scene_main",
            },
          ],
        }),
        {
          baseUrl: "data:text/html,<h1>Main%20content</h1>",
          headed: false,
          mode: "validation",
          pauseAfterSceneMs: 0,
        },
      ),
    );
    await uploadSubmittedCodeArchive({
      archiveName: "capture-sdk-smoke.tgz",
      entries: ["makeademo-capture-sdk.js", "demo-script.ts"],
      localDirectory,
      remoteDirectory: remoteSmokeDirectory,
      workspace,
    });

    const result = await executeSubmittedCode(
      workspace,
      createRuntimeVerificationCommand(),
      { timeoutMs: 45_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Submitted-code Capture SDK smoke failed with exit ${result.exitCode}: ${formatCommandOutput(result)}`,
      );
    }
    assertRuntimeVerificationEvidence(result.stdout);
  } finally {
    await rm(localDirectory, { force: true, recursive: true });
  }
}

function createRuntimeVerificationCommand() {
  const playwrightVersionCheck = [
    "const actual=require('@playwright/test/package.json').version",
    `const expected='${EXPECTED_SUBMITTED_CODE_PLAYWRIGHT_VERSION}'`,
    "if(actual!==expected){console.error(`expected Playwright ${expected}, received ${actual}`);process.exit(1)}",
    "console.log(`makeademo_playwright_version=${actual}`)",
  ].join(";");

  return [
    `cd ${shellQuote(remoteSmokeDirectory)}`,
    'makeademo_bun_version="$(bun --version)"',
    `test "$makeademo_bun_version" = ${shellQuote(EXPECTED_SUBMITTED_CODE_BUN_VERSION)}`,
    'echo "makeademo_bun_version=$makeademo_bun_version"',
    `NODE_PATH="$(npm root -g)" node -e ${shellQuote(playwrightVersionCheck)}`,
    `NODE_PATH="$(npm root -g)" timeout -k 5s 30s bun ${shellQuote("demo-script.ts")}`,
    "echo 'makeademo_capture_sdk_smoke=passed'",
  ].join(" && ");
}

function assertRuntimeVerificationEvidence(stdout: string) {
  const requiredEvidence: Array<[RegExp, string]> = [
    [
      new RegExp(
        `^makeademo_bun_version=${escapeRegExp(EXPECTED_SUBMITTED_CODE_BUN_VERSION)}$`,
        "m",
      ),
      "exact Bun version",
    ],
    [
      new RegExp(
        `^makeademo_playwright_version=${escapeRegExp(EXPECTED_SUBMITTED_CODE_PLAYWRIGHT_VERSION)}$`,
        "m",
      ),
      "exact Playwright version",
    ],
    [
      /^\[makeademo:action\].*"event":"succeeded".*"label":"expect\.toBeVisible\(/m,
      "successful instrumented Playwright assertion",
    ],
    [
      /^\[makeademo:step\].*"event":"succeeded".*"stepId":"main-heading-visible"/m,
      "backend-compiled action step",
    ],
    [
      /^\[makeademo:scene\].*"event":"succeeded".*"sceneId":"scene_main"/m,
      "successful canonical Scene",
    ],
    [/^makeademo_capture_sdk_smoke=passed$/m, "Capture SDK smoke marker"],
  ];
  for (const [pattern, label] of requiredEvidence) {
    if (!pattern.test(stdout)) {
      throw new Error(
        `Submitted-code Capture SDK smoke omitted ${label}. Output:\n${stdout}`,
      );
    }
  }
}

function formatCommandOutput(result: { stderr: string; stdout: string }) {
  return [result.stdout, result.stderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeRegExp(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
