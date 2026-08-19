import { describe, expect, it } from "vitest";
import { createDeadlineCappedWorkspace } from "./deadline-capped-workspace";
import {
  AgentHarnessJobDeadlineError,
  type AgentHarnessWorkspaceExecuteOptions,
  defaultWorkspaceCommandTimeoutMs,
} from "./workspace.interface";
import { createFakeAgentHarnessWorkspace } from "./workspace.test-helpers";

function recordingWorkspace() {
  const recorded: Array<AgentHarnessWorkspaceExecuteOptions | undefined> = [];
  const workspace = createFakeAgentHarnessWorkspace({
    execute: async (_command, options) => {
      recorded.push(options);
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    executeSubmittedCode: async (_command, options) => {
      recorded.push(options);
      return { exitCode: 0, stderr: "", stdout: "" };
    },
  });
  return { recorded, workspace };
}

describe("createDeadlineCappedWorkspace", () => {
  it("caps a stage timeout at the remaining wall-clock budget", async () => {
    // N156 (twenty): a 20-minute preparation command issued with two minutes
    // of job budget left must not be granted twenty minutes.
    const { recorded, workspace } = recordingWorkspace();
    const capped = createDeadlineCappedWorkspace(workspace, {
      atMs: Date.now() + 2_000,
      totalMs: 90 * 60_000,
    });

    await capped.execute("opencode run", { timeoutMs: 20 * 60_000 });
    await capped.executeSubmittedCode("bun install", {
      timeoutMs: 20 * 60_000,
    });

    for (const options of recorded) {
      expect(options?.timeoutMs).toBeGreaterThan(0);
      expect(options?.timeoutMs).toBeLessThanOrEqual(2_000);
    }
  });

  it("bounds an omitted timeout by the seam default and the remaining budget", async () => {
    // Omitted timeoutMs means the provider default, so the cap must
    // materialize an explicit bound: the default when budget is plentiful,
    // the remaining budget when it is not.
    const { recorded, workspace } = recordingWorkspace();

    await createDeadlineCappedWorkspace(workspace, {
      atMs: Date.now() + 60 * 60_000,
      totalMs: 90 * 60_000,
    }).execute("git status");
    await createDeadlineCappedWorkspace(workspace, {
      atMs: Date.now() + 2_000,
      totalMs: 90 * 60_000,
    }).executeSubmittedCode("curl --version");

    expect(recorded[0]?.timeoutMs).toBe(defaultWorkspaceCommandTimeoutMs);
    expect(recorded[1]?.timeoutMs).toBeGreaterThan(0);
    expect(recorded[1]?.timeoutMs).toBeLessThanOrEqual(2_000);
  });

  it("preserves the caller's other execute options", async () => {
    const { recorded, workspace } = recordingWorkspace();
    const capped = createDeadlineCappedWorkspace(workspace, {
      atMs: Date.now() + 60 * 60_000,
      totalMs: 90 * 60_000,
    });

    await capped.execute("opencode run", {
      env: { OPENCODE_CONFIG: "/tmp/config" },
      inactivityTimeoutMs: 5 * 60_000,
      retry: "none",
      timeoutMs: 3 * 60_000,
    });

    expect(recorded[0]).toMatchObject({
      env: { OPENCODE_CONFIG: "/tmp/config" },
      inactivityTimeoutMs: 5 * 60_000,
      retry: "none",
      timeoutMs: 3 * 60_000,
    });
  });

  it("refuses to start a command once the job budget is exhausted", async () => {
    // The between-stage assertion stays, but a stage mid-flight must also
    // stop issuing commands: the next command is what would carry the run
    // past the 90-minute mark.
    const { recorded, workspace } = recordingWorkspace();
    const capped = createDeadlineCappedWorkspace(workspace, {
      atMs: Date.now() - 1,
      totalMs: 90 * 60_000,
    });

    await expect(capped.execute("opencode run")).rejects.toBeInstanceOf(
      AgentHarnessJobDeadlineError,
    );
    await expect(
      capped.executeSubmittedCode("bun run build"),
    ).rejects.toBeInstanceOf(AgentHarnessJobDeadlineError);
    expect(recorded).toHaveLength(0);
  });

  it("keeps teardown and audit seams working after the deadline", async () => {
    // Once the deadline error propagates, the orchestrator still destroys
    // the workspace and collects sandbox logs; capping those would strand
    // sandboxes and lose the run's evidence.
    let destroyed = false;
    const entries: unknown[] = [];
    const workspace = createFakeAgentHarnessWorkspace({
      collectSandboxLogs: async () => ["log-line"],
      destroy: async () => {
        destroyed = true;
      },
      writeSandboxLog: async (entry) => {
        entries.push(entry);
      },
    });
    const capped = createDeadlineCappedWorkspace(workspace, {
      atMs: Date.now() - 1,
      totalMs: 90 * 60_000,
    });

    await capped.destroy();
    await capped.writeSandboxLog({ event: "deadline" });
    await expect(capped.collectSandboxLogs()).resolves.toEqual(["log-line"]);

    expect(destroyed).toBe(true);
    expect(entries).toEqual([{ event: "deadline" }]);
  });
});
