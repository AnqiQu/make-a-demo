import { describe, expect, it } from "vitest";
import { assertScriptWritingChangesAllowed } from "./read-only-boundary";

describe("assertScriptWritingChangesAllowed", () => {
  it("allows script artifacts under /workspace/.makeademo", () => {
    expect(() =>
      assertScriptWritingChangesAllowed([
        "/workspace/.makeademo/demo-script.json",
        "/workspace/.makeademo/script-candidate.json",
        "/workspace/.makeademo/script-generation-report.json",
        "/workspace/.makeademo/static-script-contract-validation.json",
      ]),
    ).not.toThrow();
  });

  it("rejects app source, package, env, fixture, mock, and config edits", () => {
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
      expect(() => assertScriptWritingChangesAllowed([path]), path).toThrow(
        "Script Writing modified disallowed workspace paths",
      );
    }
  });
});
