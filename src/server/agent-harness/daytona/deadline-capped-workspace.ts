import {
  AgentHarnessJobDeadlineError,
  type AgentHarnessWorkspace,
  type AgentHarnessWorkspaceExecuteOptions,
  defaultWorkspaceCommandTimeoutMs,
} from "./workspace.interface";

/**
 * The job's wall-clock budget as the workspace decorator sees it: the
 * absolute deadline and the total budget it was derived from (the total is
 * what the deadline error reports).
 */
export type WorkspaceJobDeadline = {
  atMs: number;
  totalMs: number;
};

/**
 * Caps every sandbox command at the remaining job wall-clock budget (N156):
 * a stage may never be granted more time than the job has left. `execute`
 * and `executeSubmittedCode` — the funnel for agent commands, lifecycle
 * waits, and install/build gates — get their `timeoutMs` clamped to
 * `min(requested-or-default, remaining)`, and once the budget is exhausted
 * they throw `AgentHarnessJobDeadlineError` instead of starting a command.
 * Every other seam member delegates unchanged: teardown, log collection,
 * and artifact transfer must keep working after the deadline so the failed
 * run keeps its sandbox cleanup and evidence.
 */
export function createDeadlineCappedWorkspace(
  workspace: AgentHarnessWorkspace,
  jobDeadline: WorkspaceJobDeadline,
): AgentHarnessWorkspace {
  const capOptions = (
    options?: AgentHarnessWorkspaceExecuteOptions,
  ): AgentHarnessWorkspaceExecuteOptions => {
    const remainingMs = jobDeadline.atMs - Date.now();
    if (remainingMs <= 0) {
      throw new AgentHarnessJobDeadlineError(jobDeadline.totalMs);
    }
    return {
      ...options,
      timeoutMs: Math.min(
        options?.timeoutMs ?? defaultWorkspaceCommandTimeoutMs,
        remainingMs,
      ),
    };
  };
  const capped: AgentHarnessWorkspace = {
    collectNetworkStateLog: () => workspace.collectNetworkStateLog(),
    collectSandboxLogs: () => workspace.collectSandboxLogs(),
    destroy: () => workspace.destroy(),
    execute: async (command, options) =>
      workspace.execute(command, capOptions(options)),
    executeSubmittedCode: async (command, options) =>
      workspace.executeSubmittedCode(command, capOptions(options)),
    promoteSubmittedCodeFiles: (paths) =>
      workspace.promoteSubmittedCodeFiles(paths),
    readSubmittedCodeAppStatus: () => workspace.readSubmittedCodeAppStatus(),
    setSubmittedCodeNetworkAccess: (enabled) =>
      workspace.setSubmittedCodeNetworkAccess(enabled),
    startSubmittedCodeApp: (input) => workspace.startSubmittedCodeApp(input),
    stopSubmittedCodeApp: () => workspace.stopSubmittedCodeApp(),
    syncSubmittedCodeWorkspace: () => workspace.syncSubmittedCodeWorkspace(),
    uploadFiles: (files) => workspace.uploadFiles(files),
    uploadSubmittedCodeFiles: (files) =>
      workspace.uploadSubmittedCodeFiles(files),
    writeSandboxLog: (entry) => workspace.writeSandboxLog(entry),
    writeTextFile: (path, contents) => workspace.writeTextFile(path, contents),
    downloadSubmittedCodeFiles: (files) =>
      workspace.downloadSubmittedCodeFiles(files),
  };
  // Live getters, not snapshots: the submitted-code sandbox id changes when
  // the provider recreates that sandbox mid-run.
  Object.defineProperty(capped, "agentSandboxId", {
    enumerable: true,
    get: () => workspace.agentSandboxId,
  });
  Object.defineProperty(capped, "submittedCodeSandboxId", {
    enumerable: true,
    get: () => workspace.submittedCodeSandboxId,
  });
  return capped;
}
