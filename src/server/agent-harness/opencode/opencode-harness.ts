import type {
  AgentHarnessCommandTimeoutError,
  AgentHarnessWorkspace,
} from "../daytona/workspace.interface";

export type OpenCodeHarnessStage =
  | "app-exploration"
  | "flow-planning"
  | "preparation-fidelity-adjudication"
  | "repair-strategy"
  | "repo-preparation"
  | "repo-preparation-repair"
  | "run-triage"
  | "runtime-target-selection"
  | "script-repair"
  | "script-writing";

export type OpenCodeHarnessRunInput = {
  availableTools: string[];
  configDir: string;
  inactivityTimeoutMs?: number;
  model: string;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  prompt: string;
  sessionId?: string;
  stage: OpenCodeHarnessStage;
  timeoutMs: number;
  workingDirectory: string;
  workspace: AgentHarnessWorkspace;
};

export type OpenCodeHarnessRunResult = {
  exitCode: number;
  sessionId?: string;
  stderr: string;
  stdout: string;
  timeoutError?: AgentHarnessCommandTimeoutError;
};

/**
 * Runs OpenCode inside the agent sandbox with stage-specific tools and prompts.
 * Implementations must treat OpenCode session memory as a cache; durable
 * artifacts remain the source of truth between stages.
 */
export interface OpenCodeHarnessRunner {
  run(input: OpenCodeHarnessRunInput): Promise<OpenCodeHarnessRunResult>;
}

export function createStagePrompt(input: {
  artifactPaths: string[];
  instructions: string;
  stage: OpenCodeHarnessStage;
}): string {
  return [
    `Stage: ${input.stage}`,
    "",
    input.instructions.trim(),
    "",
    "Durable artifacts:",
    ...input.artifactPaths.map((path) => `- ${path}`),
  ].join("\n");
}
