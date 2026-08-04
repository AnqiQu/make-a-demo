import { describe, expect, it } from "vitest";
import {
  findScriptWritingContentChanges,
  readDisallowedScriptWritingChanges,
} from "./read-only-boundary";

describe("readDisallowedScriptWritingChanges", () => {
  it("allows script artifacts under /workspace/.makeademo", () => {
    expect(
      readDisallowedScriptWritingChanges([
        "/workspace/.makeademo/demo-script.json",
        "/workspace/.makeademo/script-candidate.json",
        "/workspace/.makeademo/static-script-contract-validation.json",
      ]),
    ).toEqual([]);
  });

  it("reports unapproved files even when they are under /workspace/.makeademo", () => {
    expect(
      readDisallowedScriptWritingChanges([
        "/workspace/.makeademo/script-backdoor.json",
      ]),
    ).toEqual(["/workspace/.makeademo/script-backdoor.json"]);
  });

  it("detects content changes to a file that was already dirty at the stage boundary", () => {
    const changedPaths = findScriptWritingContentChanges({
      after: {
        "/workspace/README.md": "sha256:after",
        "/workspace/src/App.tsx": "sha256:unchanged-dirty-file",
      },
      before: {
        "/workspace/README.md": "sha256:before",
        "/workspace/src/App.tsx": "sha256:unchanged-dirty-file",
      },
    });

    expect(changedPaths).toEqual(["/workspace/README.md"]);
    expect(readDisallowedScriptWritingChanges(changedPaths)).toEqual([
      "/workspace/README.md",
    ]);
  });

  it("reports app source, package, env, fixture, mock, and config edits", () => {
    for (const path of [
      "/workspace/package.json",
      "/workspace/bun.lock",
      "/workspace/src/App.tsx",
      "/workspace/app/page.tsx",
      "/workspace/components/Button.tsx",
      "/workspace/fixtures/demo.json",
      "/workspace/mocks/api.ts",
      "/workspace/.env.local",
      "/workspace/vite.config.ts",
    ]) {
      expect(readDisallowedScriptWritingChanges([path]), path).toEqual([path]);
    }
  });
});
