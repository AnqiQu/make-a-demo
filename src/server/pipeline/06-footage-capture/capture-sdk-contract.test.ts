import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CAPTURE_SDK_CONTRACT_VERSION } from "./capture-contract-versions";
import {
  createCaptureSdkAgentContract,
  validateDemoScriptCaptureSdkTypes,
  writeGeneratedCaptureSdkHarness,
} from "./capture-sdk-contract";
import type { DemoScript } from "./demo-script.schema";

const captureSdkGlobal = globalThis as typeof globalThis & {
  __makeademoCaptureSdk?: unknown;
};

describe("Capture SDK Contract", () => {
  it("provides the agent with a canonical callback-based SDK example", () => {
    const contract = createCaptureSdkAgentContract();

    expect(contract.canonicalExample).toContain(
      "import { setup, scene, step } from './makeademo-capture-sdk';",
    );
    expect(contract.canonicalExample).toContain(
      "await setup(async ({ page, baseUrl, expect }) => {",
    );
    expect(contract.canonicalExample).toContain(
      "await scene('scene_main', async ({ page, expect }) => {",
    );
    expect(contract.canonicalExample).toContain(
      "await step('assert-main-content', async () => {",
    );
    expect(contract.canonicalExample).toContain(
      "  await expect(page.getByRole('heading', { name: 'Main content' })).toBeVisible();",
    );
    expect(contract.contractVersion).toBe(CAPTURE_SDK_CONTRACT_VERSION);
  });

  it("writes generated runtime, declaration, and instruction harness files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-sdk-"));

    await writeGeneratedCaptureSdkHarness(workspace);

    const runtime = await readFile(
      join(workspace, "makeademo-capture-sdk.js"),
      "utf8",
    );
    expect(runtime).toContain("export async function setup");
    expect(runtime).toContain("[makeademo:action]");
    expect(runtime).toContain("timeoutMs");
    await expect(
      readFile(join(workspace, "makeademo-capture-sdk.d.ts"), "utf8"),
    ).resolves.toContain("MakeADemoSceneContext");
    const instructions = await readFile(
      join(workspace, "makeademo-capture-sdk.instructions.md"),
      "utf8",
    );
    expect(instructions).toContain("Do not launch browsers");
    expect(instructions).toContain("Do not use real-time network access");
    expect(instructions).toContain("fetch");
    expect(instructions).toContain("page.evaluate");
    expect(instructions).toContain("toBeVisible or toBeInViewport");
  });

  it("emits structured step lifecycle markers within the active Scene", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-sdk-"));
    await writeGeneratedCaptureSdkHarness(workspace);
    const captureSdk = await import(
      `${pathToFileURL(join(workspace, "makeademo-capture-sdk.js")).href}?test=${Date.now()}`
    );
    const stepMarkers: Array<Record<string, unknown>> = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      if (args[0] === "[makeademo:step]") {
        stepMarkers.push(JSON.parse(String(args[1])));
      }
    };
    captureSdkGlobal.__makeademoCaptureSdk = {
      context: {
        baseUrl: "http://127.0.0.1:3000",
        expect: () => ({}),
        page: {},
      },
      startedAt: performance.now(),
    };

    try {
      await captureSdk.scene("scene_one", async () => {
        await captureSdk.step("click-submit", async () => undefined);
      });

      expect(stepMarkers).toEqual([
        {
          elapsedMs: expect.any(Number),
          event: "started",
          sceneId: "scene_one",
          stepId: "click-submit",
        },
        {
          elapsedMs: expect.any(Number),
          event: "succeeded",
          sceneId: "scene_one",
          stepId: "click-submit",
        },
      ]);
    } finally {
      console.log = originalLog;
      captureSdkGlobal.__makeademoCaptureSdk = undefined;
    }
  });

  it("holds only successful Scene results before their terminal markers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-sdk-"));
    await writeGeneratedCaptureSdkHarness(workspace);
    const captureSdk = await import(
      `${pathToFileURL(join(workspace, "makeademo-capture-sdk.js")).href}?test=${Date.now()}`
    );
    const events: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      if (args[0] === "[makeademo:scene]") {
        events.push(JSON.parse(String(args[1])).event);
      }
    };
    captureSdkGlobal.__makeademoCaptureSdk = {
      context: {
        baseUrl: "http://127.0.0.1:3000",
        expect: () => ({}),
        page: {
          waitForTimeout: async (durationMs: number) => {
            events.push(`held:${durationMs}`);
          },
        },
      },
      sceneHoldMsById: { scene_failed: 3_000, scene_one: 3_000 },
      startedAt: performance.now(),
    };

    try {
      await captureSdk.scene("scene_one", async () => undefined);
      await expect(
        captureSdk.scene("scene_failed", async () => {
          throw new Error("scene failed");
        }),
      ).rejects.toThrow("scene failed");

      expect(events).toEqual([
        "started",
        "held:3000",
        "succeeded",
        "started",
        "failed",
      ]);
    } finally {
      console.log = originalLog;
      captureSdkGlobal.__makeademoCaptureSdk = undefined;
    }
  });

  it("passes original Playwright subjects to expect while retaining action instrumentation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-sdk-"));
    await writeGeneratedCaptureSdkHarness(workspace);
    const captureSdk = await import(
      `${pathToFileURL(join(workspace, "makeademo-capture-sdk.js")).href}?test=${Date.now()}`
    );
    const rawLocator = { locatorKind: "playwright" };
    const actionMarkers: string[] = [];
    const originalLog = console.log;

    console.log = (...args: unknown[]) => {
      actionMarkers.push(args.map(String).join(" "));
    };
    captureSdkGlobal.__makeademoCaptureSdk = {
      context: {
        baseUrl: "http://127.0.0.1:3000",
        expect: (actual: unknown) => {
          if (actual !== rawLocator) {
            throw new Error("toBeVisible can be only used with Locator object");
          }
          return { toBeVisible: async () => undefined };
        },
        page: {
          locator: () => rawLocator,
        },
      },
      startedAt: performance.now(),
    };

    try {
      await captureSdk.scene(
        "scene_one",
        async ({
          expect: instrumentedExpect,
          page,
        }: {
          expect: (actual: unknown) => { toBeVisible(): Promise<void> };
          page: { locator(selector: string): unknown };
        }) => {
          await instrumentedExpect(page.locator("main")).toBeVisible();
        },
      );

      expect(actionMarkers).toEqual(
        expect.arrayContaining([
          expect.stringContaining('"event":"started"'),
          expect.stringContaining('"event":"succeeded"'),
          expect.stringContaining(
            '"label":"expect.toBeVisible(locator(main))"',
          ),
        ]),
      );
    } finally {
      console.log = originalLog;
      captureSdkGlobal.__makeademoCaptureSdk = undefined;
    }
  });

  it("injects validation timeouts without replacing optional Playwright arguments", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-sdk-"));
    await writeGeneratedCaptureSdkHarness(workspace);
    const captureSdk = await import(
      `${pathToFileURL(join(workspace, "makeademo-capture-sdk.js")).href}?test=${Date.now()}`
    );
    const receivedArguments: unknown[][] = [];
    captureSdkGlobal.__makeademoCaptureSdk = {
      actionTimeoutMs: 1_234,
      context: {
        baseUrl: "http://127.0.0.1:3000",
        expect: () => ({}),
        page: {
          waitForLoadState: (...args: unknown[]) => {
            receivedArguments.push(args);
          },
        },
      },
      startedAt: performance.now(),
    };

    try {
      await captureSdk.scene(
        "scene_one",
        async ({
          page,
        }: {
          page: { waitForLoadState(): Promise<void> };
        }) => {
          await page.waitForLoadState();
        },
      );

      expect(receivedArguments).toEqual([[undefined, { timeout: 1_234 }]]);
    } finally {
      captureSdkGlobal.__makeademoCaptureSdk = undefined;
    }
  });

  it("keeps object-valued locator selections separate from timeout options", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-sdk-"));
    await writeGeneratedCaptureSdkHarness(workspace);
    const captureSdk = await import(
      `${pathToFileURL(join(workspace, "makeademo-capture-sdk.js")).href}?test=${Date.now()}`
    );
    const receivedArguments: unknown[][] = [];
    const locator = {
      selectOption: (...args: unknown[]) => {
        receivedArguments.push(args);
      },
    };
    captureSdkGlobal.__makeademoCaptureSdk = {
      actionTimeoutMs: 1_234,
      context: {
        baseUrl: "http://127.0.0.1:3000",
        expect: () => ({}),
        page: { locator: () => locator },
      },
      startedAt: performance.now(),
    };

    try {
      await captureSdk.scene(
        "scene_one",
        async ({
          page,
        }: {
          page: {
            locator(selector: string): {
              selectOption(value: { label: string }): Promise<void>;
            };
          };
        }) => {
          await page.locator("select").selectOption({ label: "Pro" });
        },
      );

      expect(receivedArguments).toEqual([
        [{ label: "Pro" }, { timeout: 1_234 }],
      ]);
    } finally {
      captureSdkGlobal.__makeademoCaptureSdk = undefined;
    }
  });

  it("keeps object-valued page selections separate from timeout options", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-sdk-"));
    await writeGeneratedCaptureSdkHarness(workspace);
    const captureSdk = await import(
      `${pathToFileURL(join(workspace, "makeademo-capture-sdk.js")).href}?test=${Date.now()}`
    );
    const receivedArguments: unknown[][] = [];
    captureSdkGlobal.__makeademoCaptureSdk = {
      actionTimeoutMs: 1_234,
      context: {
        baseUrl: "http://127.0.0.1:3000",
        expect: () => ({}),
        page: {
          selectOption: (...args: unknown[]) => {
            receivedArguments.push(args);
          },
        },
      },
      startedAt: performance.now(),
    };

    try {
      await captureSdk.scene(
        "scene_one",
        async ({
          page,
        }: {
          page: {
            selectOption(
              selector: string,
              value: { label: string },
            ): Promise<void>;
          };
        }) => {
          await page.selectOption("select", { label: "Pro" });
        },
      );

      expect(receivedArguments).toEqual([
        ["select", { label: "Pro" }, { timeout: 1_234 }],
      ]);
    } finally {
      captureSdkGlobal.__makeademoCaptureSdk = undefined;
    }
  });

  it("keeps the optional waitForFunction argument slot ahead of timeout options", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "makeademo-sdk-"));
    await writeGeneratedCaptureSdkHarness(workspace);
    const captureSdk = await import(
      `${pathToFileURL(join(workspace, "makeademo-capture-sdk.js")).href}?test=${Date.now()}`
    );
    const receivedArguments: unknown[][] = [];
    const predicate = () => true;
    captureSdkGlobal.__makeademoCaptureSdk = {
      actionTimeoutMs: 1_234,
      context: {
        baseUrl: "http://127.0.0.1:3000",
        expect: () => ({}),
        page: {
          waitForFunction: (...args: unknown[]) => {
            receivedArguments.push(args);
          },
        },
      },
      startedAt: performance.now(),
    };

    try {
      await captureSdk.scene(
        "scene_one",
        async ({
          page,
        }: {
          page: { waitForFunction(callback: () => boolean): Promise<void> };
        }) => {
          await page.waitForFunction(predicate);
        },
      );

      expect(receivedArguments).toEqual([
        [predicate, undefined, { timeout: 1_234 }],
      ]);
    } finally {
      captureSdkGlobal.__makeademoCaptureSdk = undefined;
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

  it("types compiler step callbacks through the generated SDK declarations", async () => {
    const workspace = await sdkWorkspace();

    await expect(
      validateDemoScriptCaptureSdkTypes({
        demoPlaywrightScript: [
          "import { setup, scene, step } from './makeademo-capture-sdk';",
          "await setup(async ({ page, baseUrl }) => { await page.goto(baseUrl); });",
          "await scene('scene_one', async ({ page, expect }) => {",
          "  await step('assert-main', async () => {",
          "    await expect(page.locator('main')).toBeVisible();",
          "  });",
          "});",
        ].join("\n"),
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
        type: "playwright-recording",
      },
    ],
    scriptId: "script-001",
    title: "Demo Script",
    version: 1,
  };
}
