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

  it("lands on the tool-authored cause above the pnpm epilogue", () => {
    // N130 (directus, 2026-08-13): pnpm ends every failure with the same
    // ` ELIFECYCLE  Command failed with exit code 1.` epilogue, so three
    // distinct crashes fingerprinted as one repeat and the run died on the
    // repeated-failure limit with the budget barely touched.
    expect(
      readLastErrorCauseLine(
        [
          "/workspace/repo/packages/extensions build$ tsdown",
          '✗ [ERROR] Could not resolve "./dist/node.js"',
          " ELIFECYCLE  Command failed with exit code 1.",
          'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  "@directus/extensions#build" failed',
        ].join("\n"),
      ),
    ).toBe('✗ [ERROR] Could not resolve "./dist/node.js"');
  });

  it("lands on the script line above the npm lifecycle epilogue block", () => {
    expect(
      readLastErrorCauseLine(
        [
          "npm ERR! code ELIFECYCLE",
          "npm ERR! errno 127",
          "npm ERR! app@1.0.0 dev: `vite`",
          "npm ERR! Exit status 127",
          "npm ERR! Failed at the app@1.0.0 dev script.",
          "npm ERR! This is probably not a problem with npm.",
          "npm ERR! A complete log of this run can be found in: /root/.npm/_logs/2026-08-13T07_12_22_532Z-debug.log",
        ].join("\n"),
      ),
    ).toBe("npm ERR! app@1.0.0 dev: `vite`");
  });

  it("lands on the compiler error above the yarn epilogue", () => {
    expect(
      readLastErrorCauseLine(
        [
          "$ tsc && vite build",
          "src/App.tsx(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
          "error Command failed with exit code 2.",
          "info Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.",
        ].join("\n"),
      ),
    ).toBe(
      "src/App.tsx(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    );
  });

  it("falls back to the epilogue when nothing above it names an error", () => {
    // A wrapper epilogue is still a real error line; skipping it must never
    // turn a failing excerpt into "no cause found".
    expect(
      readLastErrorCauseLine(
        [
          "building for production...",
          " ELIFECYCLE  Command failed with exit code 1.",
        ].join("\n"),
      ),
    ).toBe("ELIFECYCLE  Command failed with exit code 1.");
  });

  it("lands on the error text above rolldown's error-named stack frames", () => {
    // N173 (twenty and directus, wave-19): rolldown's error-translation
    // files are literally named error-<hash>.mjs, so every stack frame
    // matches the error-word pattern and the LAST frame — not the error
    // text above it — became the headline of two repos' build failures.
    expect(
      readLastErrorCauseLine(
        [
          "error during build:",
          "Build failed with 2 errors:",
          "[UNLOADABLE_DEPENDENCY] Could not load src/modules/demo/isDemoMode",
          "│                                     ╰─────────── No such file or directory (os error 2)",
          "at aggregateBindingErrorsIntoJsError (file:///workspace/repo/node_modules/rolldown/dist/shared/error-BuvQYXuZ.mjs:48:18)",
          "at unwrapBindingResult (file:///workspace/repo/node_modules/rolldown/dist/shared/error-BuvQYXuZ.mjs:18:128)",
          "at async buildEnvironment (file:///workspace/repo/node_modules/vite/dist/node/chunks/node.js:33253:64)",
        ].join("\n"),
      ),
    ).toBe(
      "│                                     ╰─────────── No such file or directory (os error 2)",
    );
  });

  it("keeps a stack frame as the cause when nothing but frames name an error", () => {
    expect(
      readLastErrorCauseLine(
        [
          "building for production...",
          "at unwrapBindingResult (file:///workspace/repo/node_modules/rolldown/dist/shared/error-BuvQYXuZ.mjs:18:128)",
        ].join("\n"),
      ),
    ).toBe(
      "at unwrapBindingResult (file:///workspace/repo/node_modules/rolldown/dist/shared/error-BuvQYXuZ.mjs:18:128)",
    );
  });

  it("does not treat an error message that starts with 'at' as a stack frame", () => {
    expect(
      readLastErrorCauseLine(
        [
          "Error: build wrapper died",
          "at line 3: syntax error near unexpected token",
        ].join("\n"),
      ),
    ).toBe("at line 3: syntax error near unexpected token");
  });
});
