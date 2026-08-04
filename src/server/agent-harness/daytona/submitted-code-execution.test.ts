import { describe, expect, it, vi } from "vitest";
import { executeSubmittedCode } from "./submitted-code-execution";
import { createFakeAgentHarnessWorkspace } from "./workspace.test-helpers";

describe("executeSubmittedCode", () => {
  it("runs commands without replacing runtime files between capture operations", async () => {
    const syncSubmittedCodeWorkspace = vi.fn(async () => undefined);
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "captured",
    }));

    await expect(
      executeSubmittedCode(
        createFakeAgentHarnessWorkspace({
          executeSubmittedCode: execute,
          syncSubmittedCodeWorkspace,
        }),
        "bun /workspace/.makeademo/demo-script.ts",
      ),
    ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "captured" });

    expect(syncSubmittedCodeWorkspace).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      "bun /workspace/.makeademo/demo-script.ts",
      {},
    );
  });
});
