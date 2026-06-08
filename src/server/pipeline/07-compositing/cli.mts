import { createR2UploadPresignerFromEnv } from "../../shared/integrations/storage/r2-client";
import { R2FinalVideoStorage } from "../../shared/integrations/storage/r2-final-video-storage";
import { createNeonDemoRequestFinalVideoStore } from "../../shared/persistence/neon-demo-request-final-video-store";
import { compositeVideoFromScript } from "./composite-video";

type CliOptions = {
  captureManifestPath?: string;
  demoRequestId?: string;
  outputRoot: string;
  scriptPath: string;
};

const options = parseOptions(Bun.argv.slice(2));

if (!options.captureManifestPath) {
  printHelp();
  throw new Error("--capture-manifest must be provided");
}

const finalVideoDependencies = options.demoRequestId
  ? {
      demoRequestId: options.demoRequestId,
      demoRequestStore: createNeonDemoRequestFinalVideoStore(),
      finalVideoStorage: new R2FinalVideoStorage(
        createR2UploadPresignerFromEnv(),
      ),
    }
  : {};

const manifest = await compositeVideoFromScript({
  captureManifestPath: options.captureManifestPath,
  ...finalVideoDependencies,
  outputRoot: options.outputRoot,
  scriptPath: options.scriptPath,
});

console.log("Rendered final demo video.");
console.log(`Video: ${manifest.finalVideo?.r2Url ?? manifest.outputVideoPath}`);
console.log(`View URL: ${manifest.viewUrl}`);
console.log(`Manifest: ${manifest.manifestPath}`);
console.log(`Render plan: ${manifest.renderPlanPath}`);

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    outputRoot: ".demo-composite-renders",
    scriptPath: "demo/data/milo_video_script_example.json",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--capture-manifest") {
      options.captureManifestPath = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--demo-request-id") {
      options.demoRequestId = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--output-root") {
      options.outputRoot = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--script") {
      options.scriptPath = readFlagValue(args, index, arg);
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

function printHelp() {
  console.log(`Composite a final Remotion demo video from a Video Script Package and Capture Manifest.

Usage:
  bun run demo:composite-video -- --capture-manifest <path> [options]

Options:
  --capture-manifest <path>    Capture manifest from demo:capture-scenes
  --demo-request-id <id>       Upload final video to R2 and link it to this Demo Request in Neon
  --script <path>              Script JSON path. Defaults to demo/data/milo_video_script_example.json
  --output-root <path>         Local rendered-video storage root. Defaults to .demo-composite-renders
  --help                       Show this help
`);
}
