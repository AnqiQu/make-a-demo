import { describe, expect, it } from "vitest";

import { stripAnsi } from "./strip-ansi";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

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
});
