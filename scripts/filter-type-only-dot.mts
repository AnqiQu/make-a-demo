import { readFile, writeFile } from "node:fs/promises";

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  throw new Error("Usage: filter-type-only-dot.mts <input.dot> <output.dot>");
}

const input = await readFile(inputPath, "utf8");
const output = input
  .split("\n")
  .filter(
    (line: string) =>
      !line.includes(" -> ") || line.includes('arrowhead="onormal"'),
  )
  .map((line: string) =>
    line.includes(".interface.ts")
      ? line.replace('fillcolor="#ddfeff"', 'fillcolor="#ccffcc"')
      : line,
  )
  .join("\n");

await writeFile(outputPath, output);
