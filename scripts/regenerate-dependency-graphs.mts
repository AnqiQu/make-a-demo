import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

await run("depcruise", [
  "src",
  "--config",
  ".dependency-cruiser.graph.cjs",
  "--include-only",
  "^src",
  "--output-type",
  "dot",
  "--output-to",
  "docs/dependency-runtime-graph.dot",
]);
await run("dot", [
  "-Tsvg",
  "docs/dependency-runtime-graph.dot",
  "-o",
  "docs/dependency-runtime-graph.svg",
]);
await run("depcruise", [
  "src",
  "--config",
  ".dependency-cruiser.cjs",
  "--include-only",
  "^src",
  "--output-type",
  "dot",
  "--output-to",
  "docs/dependency-type-graph.full.dot",
]);
await run("bun", [
  "scripts/filter-type-only-dot.mts",
  "docs/dependency-type-graph.full.dot",
  "docs/dependency-type-graph.dot",
]);
await rm("docs/dependency-type-graph.full.dot");
await run("dot", [
  "-Tsvg",
  "docs/dependency-type-graph.dot",
  "-o",
  "docs/dependency-type-graph.svg",
]);

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with ${code ?? `signal ${signal}`}`,
        ),
      );
    });
  });
}
