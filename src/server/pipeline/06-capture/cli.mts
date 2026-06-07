import { captureScenesFromScript } from "./capture-scenes";
import { ensureDemoServer } from "./demo-server";
import { DefaultPlaywrightSceneRecorder } from "./playwright-scene-recorder";

type CliOptions = {
  baseUrl: string;
  headed: boolean;
  keepTemp: boolean;
  pauseAfterSceneMs: number;
  scriptPath: string;
  startServer: boolean;
  tempRoot: string;
};

const options = parseOptions(Bun.argv.slice(2));
const server = options.startServer
  ? await ensureDemoServer(options.baseUrl)
  : undefined;

try {
  const manifest = await captureScenesFromScript({
    baseUrl: options.baseUrl,
    keepTemp: options.keepTemp,
    recorder: new DefaultPlaywrightSceneRecorder({
      headed: options.headed,
      pauseAfterSceneMs: options.pauseAfterSceneMs,
    }),
    scriptPath: options.scriptPath,
    tempRoot: options.tempRoot,
  });

  console.log(`Captured ${manifest.scenes.length} temporary scene video(s).`);
  console.log(`Manifest: ${manifest.manifestPath}`);
  console.log(`Run directory: ${manifest.runDirectory}`);

  for (const scene of manifest.scenes) {
    console.log(`${scene.sceneId}: ${scene.videoPath}`);
  }
} finally {
  server?.kill();
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    baseUrl: "http://localhost:3000",
    headed: false,
    keepTemp: false,
    pauseAfterSceneMs: 0,
    scriptPath: "demo/data/milo_video_script_example.json",
    startServer: true,
    tempRoot: ".demo-capture-runs",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--base-url") {
      options.baseUrl = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--headed") {
      options.headed = true;
      continue;
    }

    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--keep-temp") {
      options.keepTemp = true;
      continue;
    }

    if (arg === "--no-start-server") {
      options.startServer = false;
      continue;
    }

    if (arg === "--pause-after-scene") {
      options.pauseAfterSceneMs = parseNonNegativeInteger(
        readFlagValue(args, index, arg),
        arg,
      );
      index += 1;
      continue;
    }

    if (arg === "--script") {
      options.scriptPath = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--temp-root") {
      options.tempRoot = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function readFlagValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} must be followed by a value`);
  }
  return value;
}

function parseNonNegativeInteger(value: string, flag: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be followed by a non-negative integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Capture temporary Playwright scene videos from a Video Script Package.

Usage:
  bun run demo:capture-scenes -- [options]

Options:
  --script <path>              Script JSON path. Defaults to demo/data/milo_video_script_example.json
  --base-url <url>             App URL to capture. Defaults to http://localhost:3000
  --temp-root <path>           Temporary capture root. Defaults to .demo-capture-runs
  --headed                     Run Playwright in a visible browser
  --pause-after-scene <ms>     Keep each scene open for extra milliseconds before closing
  --keep-temp                  Mark chunks for preservation after future compositing cleanup
  --no-start-server            Do not auto-start bun run demo
  --help                       Show this help
`);
}
