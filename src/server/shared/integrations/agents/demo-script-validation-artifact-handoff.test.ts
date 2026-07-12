import { describe, expect, it } from "vitest";

import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import {
  demoScriptPath,
  readDemoScriptArtifact,
} from "./demo-script-validation-artifact-handoff";

describe("Demo Script validation artifact handoff", () => {
  it("accepts only the fixed Demo Script path", async () => {
    const files = new Map<string, string>([
      [demoScriptPath, JSON.stringify({ scriptId: "script_1" })],
    ]);
    const workspace = fakeWorkspace(files);

    await expect(readDemoScriptArtifact(workspace)).resolves.toEqual({
      scriptId: "script_1",
    });
  });

  it("rejects another artifact path", async () => {
    await expect(
      readDemoScriptArtifact(fakeWorkspace(new Map()), "/tmp/other.json"),
    ).rejects.toThrow(demoScriptPath);
  });
});

function fakeWorkspace(files: Map<string, string>): PreparationWorkspace {
  return {
    async execute(command) {
      const path = command.match(/cat '([^']+)'/)?.[1];
      if (path === undefined) return { exitCode: 0, stderr: "", stdout: "" };
      const content = files.get(path);
      return content === undefined
        ? { exitCode: 1, stderr: "", stdout: "" }
        : { exitCode: 0, stderr: "", stdout: content };
    },
    async getPreviewUrl() {
      return "http://localhost";
    },
    async setOutboundNetworkAccess() {},
    async uploadFiles() {},
  };
}
