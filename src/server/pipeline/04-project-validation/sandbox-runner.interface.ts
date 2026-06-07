import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { NetworkAttempt } from "./network-isolation-policy";

export type SandboxValidationInput = {
  demoCommand: string;
  repoUrl: string;
  url: string;
};

export type SandboxValidationOutput = {
  blockedNetworkAttempts: NetworkAttempt[];
  logs: string[];
  repoFiles: string[];
  runtimeExitCode: number;
};

/**
 * Runs untrusted submitted project code inside an isolated sandbox.
 * Implementations must allow dependency installation, seal the runtime network
 * boundary before the demo command runs, and report any blocked boundary attempts.
 */
export interface SandboxRunner {
  runValidation(
    input: SandboxValidationInput & {
      preparationManifest: PreparationManifest;
    },
  ): Promise<SandboxValidationOutput>;
}
