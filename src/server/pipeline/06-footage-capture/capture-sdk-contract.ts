import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DemoScript } from "./demo-script.schema";

const SDK_IMPORT_PATTERN =
  /import\s+\{\s*(?:scene\s*,\s*setup|setup\s*,\s*scene)\s*\}\s+from\s+['"]\.\/makeademo-capture-sdk['"];?/;

const forbiddenCaptureControlPatterns: Array<[RegExp, string]> = [
  [/\brecordVideo\b/, "Playwright recordVideo is owned by MakeADemo"],
  [/\bchromium\.launch\b/, "browser launch is owned by MakeADemo"],
  [/\bbrowser\.newContext\b/, "browser context creation is owned by MakeADemo"],
  [
    /\[makeademo:scene\]/,
    "Scene marker emission is owned by the MakeADemo Capture SDK",
  ],
  [/\belapsedMs\b/, "marker timing is owned by MakeADemo"],
];

/**
 * Validates agent-authored Demo Script code against the generated Capture SDK
 * contract. The agent may import and call setup/scene, but must not own
 * browser recording, marker emission, output paths, or capture timestamps.
 */
export function assertDemoScriptCaptureSdkContract(script: DemoScript): void {
  if (!SDK_IMPORT_PATTERN.test(script.demoPlaywrightScript)) {
    throw new Error(
      "Demo Script must import { setup, scene } from './makeademo-capture-sdk'.",
    );
  }

  for (const [pattern, reason] of forbiddenCaptureControlPatterns) {
    if (pattern.test(script.demoPlaywrightScript)) {
      throw new Error(
        `Demo Script violates the Capture SDK Contract: ${reason}.`,
      );
    }
  }

  for (const scene of script.scenes) {
    const sceneBody = readSceneCallbackSource(
      script.demoPlaywrightScript,
      scene.id,
    );
    if (sceneBody === undefined) {
      throw new Error(
        `Demo Script must call scene(${JSON.stringify(scene.id)}, ...).`,
      );
    }
    if (!/\bexpect\s*\(/.test(sceneBody)) {
      throw new Error(
        `Scene ${scene.id} must include a visible Playwright assertion before it ends.`,
      );
    }
  }
}

export async function writeGeneratedCaptureSdkHarness(
  directory: string,
): Promise<void> {
  await Promise.all([
    writeFile(join(directory, "makeademo-capture-sdk.js"), runtimeSource()),
    writeFile(
      join(directory, "makeademo-capture-sdk.d.ts"),
      declarationSource(),
    ),
    writeFile(
      join(directory, "makeademo-capture-sdk.instructions.md"),
      instructionsSource(),
    ),
  ]);
}

export async function validateDemoScriptCaptureSdkTypes(input: {
  demoPlaywrightScript: string;
  directory: string;
}): Promise<void> {
  const contractScriptName = "demo-script.contract.ts";
  const contractScriptPath = join(input.directory, contractScriptName);
  await writeFile(contractScriptPath, input.demoPlaywrightScript);

  const result = await runTypeScriptCheck({
    cwd: input.directory,
    scriptPath: contractScriptName,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Demo Script failed Capture SDK TypeScript validation.\n${[
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n")}`,
    );
  }
}

function readSceneCallbackSource(script: string, sceneId: string) {
  const marker = new RegExp(`scene\\(\\s*['"]${escapeRegExp(sceneId)}['"]`);
  const match = marker.exec(script);
  if (match === null) {
    return undefined;
  }

  const nextSceneIndex = script
    .slice(match.index + match[0].length)
    .search(/\bscene\s*\(/);
  if (nextSceneIndex === -1) {
    return script.slice(match.index);
  }

  return script.slice(
    match.index,
    match.index + match[0].length + nextSceneIndex,
  );
}

function escapeRegExp(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runTypeScriptCheck(input: { cwd: string; scriptPath: string }) {
  return await new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const child = spawn(
      "bunx",
      [
        "tsc",
        "--noEmit",
        "--pretty",
        "false",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        "--strict",
        "--skipLibCheck",
        "--lib",
        "ES2022,DOM,DOM.Iterable",
        input.scriptPath,
      ],
      { cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}

function runtimeSource() {
  return `export async function setup() {
  const sdk = readMakeADemoCaptureSdk();
  const callback = arguments[0];
  await callback(sdk.context);
}

export async function scene() {
  const sdk = readMakeADemoCaptureSdk();
  const id = arguments[0];
  const callback = arguments[1];
  console.log('[makeademo:scene]', JSON.stringify({ elapsedMs: elapsedMs(sdk), event: 'started', sceneId: id }));
  try {
    await callback(sdk.context);
    console.log('[makeademo:scene]', JSON.stringify({ elapsedMs: elapsedMs(sdk), event: 'succeeded', sceneId: id }));
  } catch (error) {
    console.log('[makeademo:scene]', JSON.stringify({
      elapsedMs: elapsedMs(sdk),
      event: 'failed',
      message: error instanceof Error ? error.message : String(error),
      sceneId: id,
    }));
    throw error;
  }
}

function readMakeADemoCaptureSdk() {
  const sdk = globalThis.__makeademoCaptureSdk;
  if (!sdk || !sdk.context || typeof sdk.startedAt !== 'number') {
    throw new Error('MakeADemo Capture SDK was loaded outside a validation/capture harness.');
  }
  return sdk;
}

function elapsedMs(sdk) {
  return Math.max(0, Math.round(performance.now() - sdk.startedAt));
}
`;
}

function declarationSource() {
  return `import type { expect as playwrightExpect, Page } from '@playwright/test';

export type MakeADemoSceneContext = {
  baseUrl: string;
  expect: typeof playwrightExpect;
  page: Page;
};

export declare function setup(
  callback: (context: MakeADemoSceneContext) => Promise<void> | void,
): Promise<void>;

export declare function scene(
  id: string,
  callback: (context: MakeADemoSceneContext) => Promise<void> | void,
): Promise<void>;
`;
}

function instructionsSource() {
  return `# MakeADemo Capture SDK Contract

Import setup and scene from './makeademo-capture-sdk'. Put off-camera login, seeding, and navigation in setup. Put each on-camera product moment in scene(id, async ({ page, baseUrl, expect }) => { ... }). Each scene must assert a visible outcome with Playwright expect before it ends.

Do not launch browsers, create contexts, configure recordVideo, write marker logs, print [makeademo:scene] lines, or provide timestamps/durations.
`;
}
