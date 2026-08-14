import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { stripAnsi, stripAnsiFileProgram } from "./strip-ansi";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const execFileAsync = promisify(execFile);

describe("stripAnsi", () => {
  it("removes CSI sequences and OSC titles while preserving prose", () => {
    const transcript = `${ESC}[?2004h${ESC}]0;root@sandbox: /workspace${BEL}root@sandbox:/workspace# yarn rebuild failed`;

    expect(stripAnsi(transcript)).toBe(
      "root@sandbox:/workspace# yarn rebuild failed",
    );
  });

  it("normalizes carriage returns so progress rewrites read as lines", () => {
    expect(stripAnsi("progress 10%\rprogress 99%\r\ndone")).toBe(
      "progress 10%\nprogress 99%\ndone",
    );
  });

  it("drops stray ESC and BEL bytes left by partial sequences", () => {
    expect(stripAnsi(`tail${ESC}${BEL}end`)).toBe("tailend");
  });

  it("sanitizes remote evidence files with the same terminal rules", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-strip-ansi-"));
    const evidencePath = join(directory, "evidence.log");
    const transcript = `${ESC}[?2004h${ESC}]0;build${BEL}progress 10%\rprogress 99%\r\nfatal: build failed${ESC}${BEL}`;

    try {
      await writeFile(evidencePath, transcript);
      const { stdout } = await execFileAsync(process.execPath, [
        "-e",
        stripAnsiFileProgram,
        evidencePath,
      ]);

      expect(stdout).toBe(stripAnsi(transcript));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
