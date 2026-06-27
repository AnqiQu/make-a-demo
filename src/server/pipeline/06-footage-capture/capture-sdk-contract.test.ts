import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDemoScriptCaptureSdkContract,
  validateDemoScriptCaptureSdkTypes,
  writeGeneratedCaptureSdkHarness,
} from "./capture-sdk-contract";
import type { DemoScript } from "./demo-script.schema";

describe("Capture SDK Contract", () => {
  it("writes generated runtime, declaration, and instruction harness files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-sdk-"));

    await writeGeneratedCaptureSdkHarness(workspace);

    await expect(
      readFile(join(workspace, "makeademo-capture-sdk.js"), "utf8"),
    ).resolves.toContain("export async function setup");
    await expect(
      readFile(join(workspace, "makeademo-capture-sdk.d.ts"), "utf8"),
    ).resolves.toContain("MakeADemoSceneContext");
    await expect(
      readFile(
        join(workspace, "makeademo-capture-sdk.instructions.md"),
        "utf8",
      ),
    ).resolves.toContain("Do not launch browsers");
  });

  it("requires Demo Scripts to import both setup and scene from the SDK", () => {
    expect(() =>
      assertDemoScriptCaptureSdkContract(
        demoScript("import { scene } from './makeademo-capture-sdk';"),
      ),
    ).toThrow("must import { setup, scene }");
    expect(() =>
      assertDemoScriptCaptureSdkContract(
        demoScript("import { setup } from './makeademo-capture-sdk';"),
      ),
    ).toThrow("must import { setup, scene }");
  });

  it("requires each Scene to include a visible Playwright assertion", () => {
    expect(() =>
      assertDemoScriptCaptureSdkContract(
        demoScript(
          [
            "import { setup, scene } from './makeademo-capture-sdk';",
            "await scene('scene_one', async ({ page, expect }) => {",
            "  await expect(page.locator('main')).toBeVisible();",
            "});",
          ].join("\n"),
        ),
      ),
    ).not.toThrow();

    for (const script of [
      [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await scene('scene_one', async () => {",
        "  // await expect(page.locator('main')).toBeVisible();",
        "});",
      ].join("\n"),
      [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await scene('scene_one', async () => {",
        "  const fake = \"await expect(page.locator('main')).toBeVisible();\";",
        "  void fake;",
        "});",
      ].join("\n"),
      [
        "import { setup, scene } from './makeademo-capture-sdk';",
        "await scene('scene_one', async ({ expect }) => {",
        "  await expect(1).toBe(1);",
        "});",
      ].join("\n"),
    ]) {
      expect(() =>
        assertDemoScriptCaptureSdkContract(demoScript(script)),
      ).toThrow("visible Playwright assertion");
    }
  });

  it("validates Demo Script code against the generated SDK declarations", async () => {
    const workspace = await sdkWorkspace();

    await expect(
      validateDemoScriptCaptureSdkTypes({
        demoPlaywrightScript: validTypedScript(),
        directory: workspace,
      }),
    ).resolves.toBeUndefined();
  }, 20_000);

  it("rejects Demo Script code that misuses the SDK context types", async () => {
    const workspace = await sdkWorkspace();

    await expect(
      validateDemoScriptCaptureSdkTypes({
        demoPlaywrightScript: [
          "import { setup, scene } from './makeademo-capture-sdk';",
          "await setup(async ({ missingThing }) => {",
          "  await missingThing();",
          "});",
          "await scene('scene_one', async ({ page, expect }) => {",
          "  await expect(page.locator('body')).toBeVisible();",
          "});",
        ].join("\n"),
        directory: workspace,
      }),
    ).rejects.toThrow("failed Capture SDK TypeScript validation");
  }, 20_000);
});

async function sdkWorkspace() {
  const workspace = await mkdtemp(join(tmpdir(), "makeademo-sdk-"));
  await symlink(
    join(process.cwd(), "node_modules"),
    join(workspace, "node_modules"),
  );
  await writeGeneratedCaptureSdkHarness(workspace);
  return workspace;
}

function validTypedScript() {
  return [
    "import { setup, scene } from './makeademo-capture-sdk';",
    "await setup(async ({ page, baseUrl, expect }) => {",
    "  await page.goto(baseUrl);",
    "  await expect(page.locator('body')).toBeVisible();",
    "});",
    "await scene('scene_one', async ({ page, expect }) => {",
    "  await expect(page.locator('body')).toBeVisible();",
    "});",
  ].join("\n");
}

function demoScript(demoPlaywrightScript: string): DemoScript {
  return {
    demoPlaywrightScript,
    format: "16:9",
    presentation: {
      music: { enabled: false },
      textOverlays: [],
      transitions: [],
    },
    scenes: [
      {
        expectedVisibleOutcome: "Body is visible.",
        humanReadableDescription: "Show body.",
        id: "scene_one",
      },
    ],
    scriptId: "script-001",
    title: "Demo Script",
    version: 1,
  };
}
