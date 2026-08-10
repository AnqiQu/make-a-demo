import { describe, expect, it } from "vitest";
import {
  readLastErrorCauseLine,
  readStderrErrorSignal,
} from "./stderr-error-signal";

describe("readStderrErrorSignal", () => {
  it("extracts error-class lines and drops toolchain narration around them", () => {
    const signal = readStderrErrorSignal(
      [
        "$ next dev",
        "warn  - You have enabled experimental features.",
        "⨯ Error [TRPCClientError]: Failed to parse URL from /api/demo-trpc/invoice.get",
        "    at eval (webpack-internal:///(rsc)/./src/lib/client.ts:10:1)",
        "Found 0 errors. Watching for file changes.",
      ].join("\n"),
    );

    expect(signal).toBe(
      "⨯ Error [TRPCClientError]: Failed to parse URL from /api/demo-trpc/invoice.get",
    );
  });

  it("returns undefined for warning-only and zero-errors watch output", () => {
    expect(
      readStderrErrorSignal(
        [
          "warn  - Fast Refresh had to perform a full reload.",
          "(node:412) [DEP0040] DeprecationWarning: The punycode module is deprecated. Use error handling instead.",
          "Found 0 errors. Watching for file changes.",
          "compiled client and server successfully in 2.1s",
        ].join("\n"),
      ),
    ).toBeUndefined();
  });

  it("recognizes errno codes and npm error prefixes without swallowing ordinary acronyms", () => {
    expect(
      readStderrErrorSignal("connect ECONNREFUSED 127.0.0.1:5432"),
    ).toContain("ECONNREFUSED");
    expect(readStderrErrorSignal("npm ERR! code ELIFECYCLE")).toContain(
      "npm ERR!",
    );
    expect(
      readStderrErrorSignal("Loaded ESM config from vite.config.ts"),
    ).toBeUndefined();
  });

  it("deduplicates repeated error lines and bounds the signal", () => {
    const spam = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0
        ? "Error: connect timed out"
        : `Error: query ${index} exploded`,
    ).join("\n");

    const signal = readStderrErrorSignal(spam);
    const lines = signal?.split("\n") ?? [];
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(
      lines.filter((line) => line === "Error: connect timed out"),
    ).toHaveLength(1);
  });

  it("returns undefined for empty input", () => {
    expect(readStderrErrorSignal("")).toBeUndefined();
    expect(readStderrErrorSignal("   \n  \n")).toBeUndefined();
  });

  it("matches compound error-class names the way rendered error bodies spell them", () => {
    // A crashed SPA route renders "TypeError: ..." — no standalone "error"
    // word, no errno code. The signal must still recognize it, both in
    // stderr traces and in harvested body samples.
    expect(
      readStderrErrorSignal(
        "TypeError: Cannot read properties of undefined (reading 'map')",
      ),
    ).toContain("TypeError");
    expect(
      readStderrErrorSignal("ReferenceError: prisma is not defined"),
    ).toContain("ReferenceError");
    expect(readStderrErrorSignal("The terrors of production")).toBeUndefined();
  });
});

describe("readLastErrorCauseLine", () => {
  it("returns the last error-class line, past the symptom line and stack frames", () => {
    expect(
      readLastErrorCauseLine(
        [
          "Runtime preflight failed: curl: (7) Failed to connect to 127.0.0.1 port 3000",
          "$ next start",
          "Error: NEXTAUTH_SECRET must be set",
          "    at loadConfig (/workspace/apps/web/server.js:14:9)",
          "Watching for file changes.",
        ].join("\n"),
      ),
    ).toBe("Error: NEXTAUTH_SECRET must be set");
  });

  it("prefers the later cause when the excerpt carries several error-class lines", () => {
    expect(
      readLastErrorCauseLine(
        [
          "error: install script exited with code 1",
          "SyntaxError: Unexpected token '}' in /workspace/config.json",
        ].join("\n"),
      ),
    ).toBe("SyntaxError: Unexpected token '}' in /workspace/config.json");
  });

  it("recognizes package-resolution and disk-exhaustion prose that names no error word", () => {
    expect(readLastErrorCauseLine('x No package found for "react-email"')).toBe(
      'x No package found for "react-email"',
    );
    expect(
      readLastErrorCauseLine(
        "tar: ./node_modules/react/index.js: Cannot write: No space left on device",
      ),
    ).toBe(
      "tar: ./node_modules/react/index.js: Cannot write: No space left on device",
    );
  });

  it("skips warning-only and zero-errors lines when picking the cause", () => {
    expect(
      readLastErrorCauseLine(
        [
          "TypeError: Cannot read properties of undefined (reading 'map')",
          "(node:412) [DEP0040] DeprecationWarning: The punycode module is deprecated. Use error handling instead.",
          "Found 0 errors. Watching for file changes.",
        ].join("\n"),
      ),
    ).toBe("TypeError: Cannot read properties of undefined (reading 'map')");
  });

  it("returns undefined when no line names an error", () => {
    expect(
      readLastErrorCauseLine(
        "Start command could not listen on 127.0.0.1:3000\nfull log: /tmp/makeademo-run-1/app.log",
      ),
    ).toBeUndefined();
    expect(readLastErrorCauseLine("")).toBeUndefined();
  });
});
