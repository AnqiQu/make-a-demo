import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeGeneratedCaptureSdkHarness } from "./capture-sdk-contract";
import { prepareStylizedPlaywrightScript } from "./stylized-playwright-script";

describe("prepareStylizedPlaywrightScript", () => {
  it("keeps validation free of video and presentation holds", () => {
    const prepared = prepareStylizedPlaywrightScript(
      "await page.getByLabel(/message/i).fill('Show me the launch plan');\nawait page.getByRole('button', { name: /send/i }).click();",
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        mode: "validation",
        sceneHoldMsById: { scene_one: 900 },
      },
    );

    expect(prepared).toContain(
      "await humanType(page, page.getByLabel(/message/i), 'Show me the launch plan');",
    );
    expect(prepared).toContain(
      "await animatedClick(page, page.getByRole('button', { name: /send/i }));",
    );
    expect(prepared).not.toContain("recordVideo");
    expect(prepared).not.toContain("waitForTimeout(900)");
    expect(prepared).toContain("[makeademo:validation] script started");
    expect(prepared).toContain("[makeademo:validation] script failed");
    expect(prepared).not.toContain("locator.first()");
  });

  it("executes the same humanized browser actions during validation and recording", () => {
    const script =
      "await page.getByLabel(/message/i).fill('Show me the launch plan');\nawait page.getByRole('button', { name: /send/i }).click();";
    const validation = prepareStylizedPlaywrightScript(script, {
      baseUrl: "http://127.0.0.1:3000",
      headed: false,
      mode: "validation",
    });
    const recording = prepareStylizedPlaywrightScript(script, {
      baseUrl: "http://127.0.0.1:3000",
      headed: false,
      mode: "recording",
      videoDirectory: ".demo-capture-runs/run/playwright-videos",
    });

    for (const prepared of [validation, recording]) {
      expect(prepared).toContain(
        "await humanType(page, page.getByLabel(/message/i), 'Show me the launch plan');",
      );
      expect(prepared).toContain(
        "await animatedClick(page, page.getByRole('button', { name: /send/i }));",
      );
    }
    expect(validation).not.toContain("recordVideo");
    expect(recording).toContain("recordVideo");
  });

  it("removes a multiline Capture SDK import as one complete declaration", () => {
    const prepared = prepareStylizedPlaywrightScript(
      [
        "import {",
        "  setup,",
        "  scene,",
        "} from './makeademo-capture-sdk';",
        "await scene('scene_one', async ({ page, expect }) => {",
        "  await expect(page.locator('main')).toBeVisible();",
        "});",
      ].join("\n"),
      {
        baseUrl: "http://127.0.0.1:3000",
        headed: false,
        mode: "validation",
      },
    );

    expect(prepared).not.toContain("  setup,");
    expect(prepared).not.toContain("  scene,");
    expect(prepared).not.toContain("} from './makeademo-capture-sdk';");
    expect(prepared).toContain(
      'import { setup, scene, step } from "./makeademo-capture-sdk.js";',
    );
  });

  it("binds the compiler step helper in validation and recording wrappers", () => {
    const script = [
      "import { setup, scene, step } from './makeademo-capture-sdk';",
      "await scene('scene_one', async () => {",
      "  await step('open-main', async () => undefined);",
      "});",
    ].join("\n");

    for (const mode of ["validation", "recording"] as const) {
      const prepared = prepareStylizedPlaywrightScript(script, {
        baseUrl: "http://127.0.0.1:3000",
        headed: false,
        mode,
        ...(mode === "recording"
          ? { videoDirectory: ".demo-capture-runs/run/playwright-videos" }
          : {}),
      });

      expect(prepared).toContain(
        'import { setup, scene, step } from "./makeademo-capture-sdk.js";',
      );
      expect(prepared).toContain(
        "await step('open-main', async () => undefined);",
      );
    }
  });

  it("blocks Service Workers in validation and recording browser contexts", () => {
    for (const mode of ["validation", "recording"] as const) {
      const prepared = prepareStylizedPlaywrightScript(
        "await page.goto(baseUrl);",
        {
          baseUrl: "http://127.0.0.1:3000",
          headed: false,
          mode,
          ...(mode === "recording"
            ? { videoDirectory: ".demo-capture-runs/run/playwright-videos" }
            : {}),
        },
      );

      expect(prepared).toContain('serviceWorkers: "block"');
    }
  });

  it("prevents Service Worker registration in the real validation browser runtime", async () => {
    const requestedPaths: string[] = [];
    const server = createServer((request, response) => {
      requestedPaths.push(request.url ?? "");
      response.writeHead(200, {
        "content-type":
          request.url === "/sw.js"
            ? "text/javascript"
            : "text/html; charset=utf-8",
      });
      response.end(
        request.url === "/sw.js"
          ? "self.addEventListener('fetch', () => undefined);"
          : "<main>Service Worker test</main>",
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test server did not expose a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-service-worker-lockdown-test-"),
    );
    await symlink(
      join(process.cwd(), "node_modules"),
      join(runDirectory, "node_modules"),
    );
    const scriptPath = join(runDirectory, "demo-script.ts");
    await writeGeneratedCaptureSdkHarness(runDirectory);
    await writeFile(
      scriptPath,
      prepareStylizedPlaywrightScript(
        [
          "await page.goto(baseUrl);",
          "const serviceWorkerState = await page.evaluate(async () => {",
          "  try {",
          "    const registration = await navigator.serviceWorker.register('/sw.js');",
          "    await new Promise((resolve) => setTimeout(resolve, 200));",
          "    return { active: Boolean(registration.active), controlled: Boolean(navigator.serviceWorker.controller) };",
          "  } catch {",
          "    return { active: false, controlled: false };",
          "  }",
          "});",
          "if (serviceWorkerState.active || serviceWorkerState.controlled) throw new Error('Service Worker escaped lockdown');",
        ].join("\n"),
        {
          baseUrl,
          headed: false,
          mode: "validation",
        },
      ),
    );

    try {
      const result = await runPreparedScript(scriptPath);

      expect(result, result.stderr).toMatchObject({ exitCode: 0 });
      expect(requestedPaths).not.toContain("/sw.js");
    } finally {
      server.close();
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("replays an exact external browser resource without outbound access", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwX9WQAAAABJRU5ErkJggg==",
      "base64",
    );
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<main><img alt="Original product" src="https://assets.example.com/product.png"></main>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test server did not expose a TCP port");
    }
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-resource-replay-test-"),
    );
    const resourcesDirectory = join(runDirectory, "external-resources");
    await mkdir(join(resourcesDirectory, "resources"), { recursive: true });
    await writeFile(join(resourcesDirectory, "resources", "image"), png);
    await symlink(
      join(process.cwd(), "node_modules"),
      join(runDirectory, "node_modules"),
    );
    const scriptPath = join(runDirectory, "demo-script.ts");
    await writeGeneratedCaptureSdkHarness(runDirectory);
    await writeFile(
      scriptPath,
      prepareStylizedPlaywrightScript(
        [
          "await page.goto(baseUrl);",
          "await expect(page.getByRole('img', { name: 'Original product' })).toHaveJSProperty('naturalWidth', 1);",
        ].join("\n"),
        {
          baseUrl: `http://127.0.0.1:${address.port}`,
          externalResourceManifest: {
            entries: [
              {
                contentType: "image/png",
                headers: {},
                relativePath: "resources/image",
                sha256:
                  "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                sizeBytes: png.byteLength,
                status: 200,
                url: "https://assets.example.com/product.png",
              },
            ],
            version: "2026-07-14",
          },
          externalResourceRoot: resourcesDirectory,
          headed: false,
          mode: "validation",
        },
      ),
    );

    try {
      const result = await runPreparedScript(scriptPath);
      expect(result, result.stderr).toMatchObject({ exitCode: 0 });
      expect(result.stderr).not.toContain("[makeademo:network-blocked]");
    } finally {
      server.close();
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("allows same-app WebSockets while logging and closing external sockets", () => {
    const prepared = prepareStylizedPlaywrightScript(
      "await page.goto(baseUrl);",
      {
        baseUrl: "http://127.0.0.1:3000",
        headed: false,
        mode: "validation",
      },
    );

    expect(prepared).toContain("await context.routeWebSocket(/.*/");
    expect(prepared).toContain("isMakeADemoAllowedRuntimeWebSocket");
    expect(prepared).toContain("webSocket.connectToServer()");
    expect(prepared).toContain('resourceType: "websocket"');
    expect(prepared).toContain(
      'await webSocket.close({ code: 1008, reason: "External network access blocked by MakeADemo" });',
    );
  });

  it("blocks an external WebSocket in the real validation browser runtime", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-websocket-lockdown-test-"),
    );
    await symlink(
      join(process.cwd(), "node_modules"),
      join(runDirectory, "node_modules"),
    );
    const scriptPath = join(runDirectory, "demo-script.ts");
    await writeGeneratedCaptureSdkHarness(runDirectory);
    await writeFile(
      scriptPath,
      prepareStylizedPlaywrightScript(
        [
          'await page.goto("data:text/html,<main>WebSocket test</main>");',
          'await page.evaluate(() => { new WebSocket("wss://example.com/socket"); });',
          "await page.waitForTimeout(100);",
        ].join("\n"),
        {
          baseUrl: "http://127.0.0.1:3000",
          headed: false,
          mode: "validation",
        },
      ),
    );

    try {
      const result = await runPreparedScript(scriptPath);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("[makeademo:network-blocked]");
      expect(result.stderr).toContain('"resourceType":"websocket"');
      expect(result.stderr).toContain('"url":"wss://example.com/socket"');
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("executes Demo Script setup and scene helpers during validation", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-validation-script-test-"),
    );
    await symlink(
      join(process.cwd(), "node_modules"),
      join(runDirectory, "node_modules"),
    );
    const scriptPath = join(runDirectory, "demo-script.ts");
    await writeGeneratedCaptureSdkHarness(runDirectory);
    const prepared = prepareStylizedPlaywrightScript(
      [
        "await setup(async ({ page, baseUrl, expect }) => {",
        "  await page.goto(baseUrl);",
        "  await expect(page.locator('body')).toBeVisible();",
        "  console.log('setup callback ran', page.url());",
        "});",
        "await scene('scene_validation', async ({ page, baseUrl, expect }) => {",
        "  await expect(page.locator('main')).toContainText('MakeADemo');",
        "  console.log('scene callback ran', baseUrl);",
        "});",
      ].join("\n"),
      {
        baseUrl: "data:text/html,<main>MakeADemo</main>",
        headed: false,
        mode: "validation",
      },
    );

    await writeFile(scriptPath, prepared);

    try {
      const result = await runPreparedScript(scriptPath);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("setup callback ran");
      expect(result.stdout).toContain("scene callback ran");
      expect(readSceneMarkers(result.stdout)).toEqual([
        expect.objectContaining({
          event: "started",
          sceneId: "scene_validation",
        }),
        expect.objectContaining({
          event: "succeeded",
          sceneId: "scene_validation",
        }),
      ]);
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("types filled text with human pacing instead of instantly setting the input", () => {
    const prepared = prepareStylizedPlaywrightScript(
      "await page.getByLabel(/message/i).fill('Show me the launch plan');",
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain("const humanTypingDelayMs = 100;");
    expect(prepared).toContain(
      "await humanType(page, page.getByLabel(/message/i), 'Show me the launch plan');",
    );
    expect(prepared).not.toContain(".fill('Show me the launch plan')");
  });

  it("defines Demo Script helpers in the recording wrapper", () => {
    const prepared = prepareStylizedPlaywrightScript(
      [
        "await setup(async ({ page, baseUrl, expect }) => {",
        "  await page.goto(baseUrl);",
        "  await expect(page.locator('body')).toBeVisible();",
        "});",
        "await scene('scene_recording', async ({ page }) => {",
        "  await page.getByRole('button', { name: /send/i }).click();",
        "});",
      ].join("\n"),
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain(
      'import { setup, scene, step } from "./makeademo-capture-sdk.js";',
    );
    expect(prepared).not.toContain("async function setup(callback)");
    expect(prepared).not.toContain("async function scene(id, callback)");
    expect(prepared).toContain(
      "const makeADemoCaptureContext = { page, baseUrl, expect };",
    );
    expect(prepared).toContain("globalThis.__makeademoCaptureSdk");
    expect(prepared).toContain("recordVideo");
    expect(prepared).toContain(
      "await animatedClick(page, page.getByRole('button', { name: /send/i }));",
    );
  });

  it("emits a failed Scene marker before rethrowing scene callback failures", async () => {
    const runDirectory = await mkdtemp(
      join(tmpdir(), "makeademo-validation-script-test-"),
    );
    await symlink(
      join(process.cwd(), "node_modules"),
      join(runDirectory, "node_modules"),
    );
    const scriptPath = join(runDirectory, "demo-script.ts");
    await writeGeneratedCaptureSdkHarness(runDirectory);
    const prepared = prepareStylizedPlaywrightScript(
      [
        "await scene('scene_failure', async () => {",
        "  throw new Error('scene exploded');",
        "});",
      ].join("\n"),
      {
        baseUrl: "data:text/html,<main>MakeADemo</main>",
        headed: false,
        mode: "validation",
      },
    );

    await writeFile(scriptPath, prepared);

    try {
      const result = await runPreparedScript(scriptPath);

      expect(result.exitCode).not.toBe(0);
      expect(readSceneMarkers(result.stdout)).toEqual([
        expect.objectContaining({ event: "started", sceneId: "scene_failure" }),
        expect.objectContaining({
          event: "failed",
          message: "scene exploded",
          sceneId: "scene_failure",
        }),
      ]);
      expect(result.stderr).toContain("scene exploded");
    } finally {
      await rm(runDirectory, { force: true, recursive: true });
    }
  }, 20_000);

  it("animates clicks through the visible recording pointer", () => {
    const prepared = prepareStylizedPlaywrightScript(
      "await page.getByRole('button', { name: /send/i }).click();",
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain("async function animatedClick(page, locator)");
    expect(prepared).toContain(
      "await animatedClick(page, page.getByRole('button', { name: /send/i }));",
    );
    expect(prepared).not.toContain(
      "await page.getByRole('button', { name: /send/i }).click();",
    );
  });

  it("animates hovers through the visible recording pointer", () => {
    const prepared = prepareStylizedPlaywrightScript(
      "await page.getByRole('button', { name: /launch plan chat/i }).hover();",
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain("async function animatedHover(page, locator)");
    expect(prepared).toContain(
      "await animatedHover(page, page.getByRole('button', { name: /launch plan chat/i }));",
    );
    expect(prepared).not.toContain(
      "await page.getByRole('button', { name: /launch plan chat/i }).hover();",
    );

    const hoverHelper = getFunctionSource(prepared, "animatedHover");
    expect(hoverHelper).toContain("await page.mouse.move(");
    expect(hoverHelper).not.toContain("target.click");
    expect(hoverHelper).not.toContain("target.hover");
    expect(hoverHelper).not.toContain("pulseRecordingPointer");
  });

  it("animates scripted transcript scrolls", () => {
    const prepared = prepareStylizedPlaywrightScript(
      `const transcript = page.getByRole('log', { name: /conversation transcript/i });
await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight; });
await transcript.evaluate((element) => { element.scrollTop = 0; });`,
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain("async function animatedScrollTo(page, locator");
    expect(prepared).toContain(
      "async function showScrollCue(page, box, position)",
    );
    expect(prepared).toContain("async function hideScrollCue(page)");
    expect(prepared).toContain("await showScrollCue(page, box, position);");
    expect(prepared).toContain("await hideScrollCue(page);");
    expect(prepared).toContain(
      'await animatedScrollTo(page, transcript, "bottom");',
    );
    expect(prepared).toContain(
      'await animatedScrollTo(page, transcript, "top");',
    );
    expect(prepared).not.toContain("element.scrollTop = element.scrollHeight");
    expect(prepared).not.toContain("element.scrollTop = 0");
  });

  it("does not rewrite the recording helper internals when preparing full Playwright scripts", () => {
    const prepared = prepareStylizedPlaywrightScript(
      `import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const context = await browser.newContext({
  recordVideo: { dir: "artifacts/videos" },
});
const page = await context.newPage();
await page.getByRole("button", { name: /send/i }).click();
await context.close();
await browser.close();`,
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain(
      'await animatedClick(page, page.getByRole("button", { name: /send/i }));',
    );
    expect(prepared).toContain("await target.click();");
  });
});

async function runPreparedScript(scriptPath: string) {
  return await new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const child = spawn("bun", [scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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

function readSceneMarkers(stdout: string) {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("[makeademo:scene] "))
    .map((line) => JSON.parse(line.slice("[makeademo:scene] ".length)));
}

function getFunctionSource(source: string, functionName: string) {
  const start = source.indexOf(`async function ${functionName}`);
  expect(start).toBeGreaterThanOrEqual(0);

  const nextFunction = source.indexOf("\nasync function ", start + 1);
  if (nextFunction === -1) {
    return source.slice(start);
  }

  return source.slice(start, nextFunction);
}
