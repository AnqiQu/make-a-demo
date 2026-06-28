import { describe, expect, it } from "vitest";

import type { PreparationWorkspace } from "./preparation-workspace.interface";
import {
  executeSubmittedCode,
  setSubmittedCodeNetworkAccess,
} from "./submitted-code-execution";

describe("submitted-code execution helpers", () => {
  it("fails instead of falling back to outer workspace execution", async () => {
    await expect(
      executeSubmittedCode(fakeWorkspace(), "npm run build"),
    ).rejects.toThrow("Preparation workspace cannot execute submitted code");
  });

  it("fails instead of falling back to outer workspace network controls", async () => {
    await expect(
      setSubmittedCodeNetworkAccess(fakeWorkspace(), true),
    ).rejects.toThrow(
      "Preparation workspace cannot control submitted-code network access",
    );
  });
});

function fakeWorkspace(): PreparationWorkspace {
  return {
    async execute() {
      throw new Error("outer workspace execution must not run submitted code");
    },
    async getPreviewUrl() {
      return "https://preview.example.test";
    },
    async setOutboundNetworkAccess() {},
    async uploadFiles() {},
  };
}
