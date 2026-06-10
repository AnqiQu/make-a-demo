import { describe, expect, it } from "vitest";

import { uploadPreparedWorkspaceFiles } from "./preparation-workspace-upload";
import type { PreparationWorkspace } from "./preparation-workspace.interface";

describe("uploadPreparedWorkspaceFiles", () => {
  it("uploads screened workspace files into the preparation workspace", async () => {
    const uploaded: Array<{ destinationPath: string; sourcePath: string }> = [];
    const workspace: PreparationWorkspace = {
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async setOutboundNetworkAccess() {},
      async uploadFiles(files) {
        uploaded.push(...files);
      },
    };

    await uploadPreparedWorkspaceFiles({
      files: [
        {
          destinationPath: "/workspace/package.json",
          sourcePath: "/tmp/repo/package.json",
        },
        {
          destinationPath: "/workspace/src/app.ts",
          sourcePath: "/tmp/repo/src/app.ts",
        },
      ],
      workspace,
    });

    expect(uploaded).toEqual([
      {
        destinationPath: "/workspace/package.json",
        sourcePath: "/tmp/repo/package.json",
      },
      {
        destinationPath: "/workspace/src/app.ts",
        sourcePath: "/tmp/repo/src/app.ts",
      },
    ]);
  });
});
