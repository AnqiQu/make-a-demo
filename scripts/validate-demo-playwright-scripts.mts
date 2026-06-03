import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Scene = {
  id: string;
  humanReadableDescription: string;
  durationSeconds: number;
  events: string[];
  playwrightScript: string;
};

type Section = {
  id: string;
  title: string;
  scenes: Scene[];
};

type DemoScript = {
  scriptId: string;
  title: string;
  version: number;
  estimatedDurationSeconds: number;
  format: string;
  sections: Section[];
};

const demoScriptPath = "demo/data/anqi_playwright_script_example.json";
const runDirectory = ".demo-script-runs";
const demoUrl = "http://localhost:3000";
const options = parseOptions(Bun.argv.slice(2));

const demoScript = (await Bun.file(demoScriptPath).json()) as DemoScript;
validateDemoScript(demoScript);

const scenes = demoScript.sections.flatMap((section) => section.scenes);
const server = await ensureDemoServer();

await rm(runDirectory, { force: true, recursive: true });
await mkdir(runDirectory, { recursive: true });

try {
  for (const scene of scenes) {
    const scenePath = join(runDirectory, `${scene.id}.ts`);
    await writeFile(scenePath, preparePlaywrightScript(scene.playwrightScript));

    const startedAt = Date.now();
    const child = Bun.spawn(["bun", scenePath], {
      stderr: "pipe",
      stdout: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (exitCode !== 0) {
      console.error(`Scene ${scene.id} failed.`);
      if (stdout.trim()) {
        console.error(stdout);
      }
      if (stderr.trim()) {
        console.error(stderr);
      }
      process.exit(exitCode);
    }

    const durationSeconds = Math.max(
      1,
      Math.round((Date.now() - startedAt) / 1000),
    );

    if (shouldUpdateDurations()) {
      scene.durationSeconds = durationSeconds;
    }

    console.log(`Scene ${scene.id} passed in ${durationSeconds}s.`);
  }

  if (shouldUpdateDurations()) {
    demoScript.estimatedDurationSeconds = scenes.reduce(
      (total, scene) => total + scene.durationSeconds,
      0,
    );
    await writeFile(demoScriptPath, `${JSON.stringify(demoScript, null, 2)}\n`);
    console.log(
      `Updated scene durations. Estimated total: ${demoScript.estimatedDurationSeconds}s.`,
    );
  }
} finally {
  await rm(runDirectory, { force: true, recursive: true });
  server?.kill();
}

function shouldUpdateDurations() {
  return (
    options.updateDurations &&
    !options.headed &&
    options.pauseAfterSceneMs === 0
  );
}

function parseOptions(args: string[]) {
  const options = {
    headed: false,
    pauseAfterSceneMs: 0,
    updateDurations: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--headed") {
      options.headed = true;
      continue;
    }

    if (arg === "--pause-after-scene") {
      options.pauseAfterSceneMs = parsePositiveInteger(
        args[index + 1],
        "--pause-after-scene",
      );
      index += 1;
      continue;
    }

    if (arg === "--update-durations") {
      options.updateDurations = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function parsePositiveInteger(value: string | undefined, flag: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be followed by a non-negative integer`);
  }
  return parsed;
}

function preparePlaywrightScript(script: string) {
  let prepared = script;

  if (options.headed) {
    prepared = prepared.replace(
      "chromium.launch();",
      "chromium.launch({ headless: false });",
    );
  }

  if (options.pauseAfterSceneMs > 0) {
    prepared = prepared.replace(
      "await context.close();",
      `await page.waitForTimeout(${options.pauseAfterSceneMs});\nawait context.close();`,
    );
  }

  return prepared;
}

function validateDemoScript(script: DemoScript) {
  assertNonEmptyString(script.scriptId, "scriptId");
  assertNonEmptyString(script.title, "title");
  assertPositiveNumber(script.version, "version");
  assertPositiveNumber(
    script.estimatedDurationSeconds,
    "estimatedDurationSeconds",
  );
  assertNonEmptyString(script.format, "format");

  if (!Array.isArray(script.sections) || script.sections.length === 0) {
    throw new Error("sections must be a non-empty array");
  }

  for (const [sectionIndex, section] of script.sections.entries()) {
    const sectionPath = `sections[${sectionIndex}]`;
    assertNonEmptyString(section.id, `${sectionPath}.id`);
    assertNonEmptyString(section.title, `${sectionPath}.title`);

    if (!Array.isArray(section.scenes) || section.scenes.length === 0) {
      throw new Error(`${sectionPath}.scenes must be a non-empty array`);
    }

    for (const [sceneIndex, scene] of section.scenes.entries()) {
      const scenePath = `${sectionPath}.scenes[${sceneIndex}]`;
      assertNonEmptyString(scene.id, `${scenePath}.id`);
      assertNonEmptyString(
        scene.humanReadableDescription,
        `${scenePath}.humanReadableDescription`,
      );
      assertPositiveNumber(
        scene.durationSeconds,
        `${scenePath}.durationSeconds`,
      );

      if (!Array.isArray(scene.events) || scene.events.length === 0) {
        throw new Error(`${scenePath}.events must be a non-empty array`);
      }

      for (const [eventIndex, event] of scene.events.entries()) {
        assertNonEmptyString(event, `${scenePath}.events[${eventIndex}]`);
      }

      assertNonEmptyString(
        scene.playwrightScript,
        `${scenePath}.playwrightScript`,
      );
    }
  }
}

function assertNonEmptyString(value: unknown, path: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
}

function assertPositiveNumber(value: unknown, path: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive number`);
  }
}

async function ensureDemoServer() {
  if (await demoServerIsReachable()) {
    return undefined;
  }

  const server = Bun.spawn(["bun", "run", "demo"], {
    stderr: "pipe",
    stdout: "pipe",
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await demoServerIsReachable()) {
      return server;
    }
    await Bun.sleep(250);
  }

  const [stdout, stderr] = await Promise.all([
    new Response(server.stdout).text(),
    new Response(server.stderr).text(),
  ]);

  server.kill();
  throw new Error(
    `Demo server did not start at ${demoUrl}.\n${stdout}\n${stderr}`.trim(),
  );
}

async function demoServerIsReachable() {
  try {
    const response = await fetch(demoUrl);
    return response.ok;
  } catch {
    return false;
  }
}
