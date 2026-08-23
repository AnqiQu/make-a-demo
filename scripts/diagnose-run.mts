import { exit } from "node:process";
import {
  draftWaveDiagnosisNote,
  resolveRunEntryDirectories,
} from "../src/server/agent-harness/diagnosis/wave-diagnosis";

// Offline diagnostician (meta-agent plan, phase M3): reads a completed run's
// artifacts and prints a draft wave-diagnosis note for human review. Never
// part of the pipeline; never writes anything.
const paths = Bun.argv.slice(2);
if (paths.length === 0) {
  console.error(
    "Usage: bun run diagnose:run <run-directory> [<run-directory> ...]\n" +
      "Each argument is a matrix entry directory or a batch root such as .makeademo-terminal-runs.",
  );
  exit(2);
}

const entryDirectories = await resolveRunEntryDirectories(paths);
if (entryDirectories.length === 0) {
  console.error(
    `No run entries found under: ${paths.join(", ")}\nExpected <entry>/artifacts/workspace/.makeademo to exist.`,
  );
  exit(1);
}

console.log(await draftWaveDiagnosisNote(entryDirectories));
