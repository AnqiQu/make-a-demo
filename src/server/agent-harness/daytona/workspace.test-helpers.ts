import type {
  AgentHarnessSubmittedCodeAppStatus,
  AgentHarnessWorkspace,
} from "./workspace.interface";

/**
 * Builds a complete no-op AgentHarnessWorkspace for tests. Every seam member
 * is implemented, so suites can rely on the full workspace contract and only
 * override the members whose behavior the test observes. Overrides are spread
 * last and win over the defaults.
 */
export function createFakeAgentHarnessWorkspace(
  overrides: Partial<AgentHarnessWorkspace> = {},
): AgentHarnessWorkspace {
  return {
    cancelActiveCommands: async () => {},
    collectNetworkStateLog: async () => [],
    collectSandboxLogs: async () => [],
    destroy: async () => {},
    downloadFiles: async () => {},
    downloadSubmittedCodeFiles: async () => {},
    execute: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
    executeSubmittedCode: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
    getPreviewUrl: async (port: number) => `http://127.0.0.1:${port}`,
    promoteSubmittedCodeFiles: async () => {},
    readSubmittedCodeAppStatus:
      async (): Promise<AgentHarnessSubmittedCodeAppStatus> => ({
        running: true,
        stderr: "",
        stdout: "",
      }),
    setSubmittedCodeNetworkAccess: async () => {},
    startSubmittedCodeApp: async () => {},
    stopSubmittedCodeApp: async () => {},
    syncSubmittedCodeWorkspace: async () => {},
    uploadFiles: async () => {},
    uploadSubmittedCodeFiles: async () => {},
    writeSandboxLog: async () => {},
    writeTextFile: async () => {},
    ...overrides,
  };
}
