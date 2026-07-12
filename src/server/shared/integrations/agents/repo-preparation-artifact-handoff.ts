import { readPreparationManifest } from "../../../pipeline/03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceCommandResult } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import type { RepoPreparationAgent } from "../../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import type { ProjectValidationResult } from "../../../pipeline/05-capture-path-validation/project-runtime-preflight/validation-result";
import {
  parseOpenCodeJsonPayload,
  tryParseJson,
} from "./makeademo-opencode-tool-protocol";

export const makeADemoArtifactDirectory = "/tmp/makeademo/submitted-code";
export const dependencyInstallRequestPath = `${makeADemoArtifactDirectory}/dependency-install-request.json`;
export const preparationManifestPath = `${makeADemoArtifactDirectory}/preparation-manifest.json`;
const preparationResultPath = `${makeADemoArtifactDirectory}/repo-preparation-result.json`;
const validationRequestPath = `${makeADemoArtifactDirectory}/validation-request.json`;
const validationResultPath = `${makeADemoArtifactDirectory}/validation-result.json`;

export type DependencyInstallRequest = { command: string };
export type ValidationRequest = { manifestPath: string };
type PreparationResult = Awaited<ReturnType<RepoPreparationAgent["prepare"]>>;

/** Reads the durable submit artifact first, falling back to OpenCode JSON output. */
export async function readPreparationResultOrParseStdout(
  workspace: PreparationWorkspace,
  commandResult: PreparationWorkspaceCommandResult,
): Promise<PreparationResult> {
  return (
    (await readPreparationResult(workspace)) ??
    parseOpenCodeJsonResult(commandResult.stdout)
  );
}

export async function readPreparationResult(
  workspace: PreparationWorkspace,
): Promise<PreparationResult | undefined> {
  const result = await workspace.execute(
    readFileCommand(preparationResultPath),
  );
  if (result.exitCode !== 0) return undefined;
  const payload = tryParseJson(result.stdout);
  if (payload === undefined)
    throw new Error("Repo Preparation submit tool wrote invalid JSON.");
  return payload as PreparationResult;
}

export function parseOpenCodeJsonResult(stdout: string): PreparationResult {
  const payload = parseOpenCodeJsonPayload(stdout);
  if (payload !== undefined) return payload as PreparationResult;
  return {
    assumptions: [],
    blockers: ["OpenCode did not return valid preparation JSON."],
    status: "failed",
    suggestedChanges: ["Retry Repo Preparation and require JSON-only output."],
  };
}

export async function readValidationRequest(
  workspace: PreparationWorkspace,
): Promise<ValidationRequest | undefined> {
  const result = await workspace.execute(
    readFileCommand(validationRequestPath),
  );
  if (result.exitCode !== 0) return undefined;
  const payload = tryParseJson(result.stdout);
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("manifestPath" in payload) ||
    typeof payload.manifestPath !== "string"
  ) {
    throw new Error("Validation tool wrote an invalid request.");
  }
  return payload as ValidationRequest;
}

export async function readPreparationManifestFile(
  workspace: PreparationWorkspace,
  manifestPath: string,
): Promise<ReturnType<typeof readPreparationManifest>> {
  if (manifestPath !== preparationManifestPath) {
    throw new Error(
      `Validation manifest path must be ${preparationManifestPath}.`,
    );
  }
  const result = await workspace.execute(
    readFileCommand(preparationManifestPath),
  );
  if (result.exitCode !== 0)
    throw new Error("Preparation manifest file is missing.");
  const payload = tryParseJson(result.stdout);
  if (payload === undefined)
    throw new Error("Preparation manifest file contains invalid JSON.");
  return readPreparationManifest(payload);
}

export async function writeValidationResult(
  workspace: PreparationWorkspace,
  input: {
    manifest: ReturnType<typeof readPreparationManifest> | undefined;
    validation: ProjectValidationResult;
  },
): Promise<void> {
  const artifact = {
    manifest: input.manifest,
    status: input.validation.status,
    validation: input.validation,
  };
  const result = await workspace.execute(
    `mkdir -p ${shellQuote(makeADemoArtifactDirectory)} && cat > ${shellQuote(validationResultPath)} <<'MAKEADEMO_VALIDATION_RESULT'\n${JSON.stringify(artifact, null, 2)}\nMAKEADEMO_VALIDATION_RESULT`,
  );
  if (result.exitCode !== 0)
    throw new Error("Failed to write validation result artifact.");
}

export async function readValidationResult(
  workspace: PreparationWorkspace,
): Promise<ProjectValidationResult | undefined> {
  const result = await workspace.execute(readFileCommand(validationResultPath));
  if (result.exitCode !== 0) return undefined;
  const payload = tryParseJson(result.stdout) as
    | { validation?: ProjectValidationResult }
    | undefined;
  return payload?.validation;
}

export async function clearValidationRequest(
  workspace: PreparationWorkspace,
): Promise<void> {
  const result = await workspace.execute(
    `rm -f ${shellQuote(validationRequestPath)}`,
  );
  if (result.exitCode !== 0)
    throw new Error("Failed to clear validation request artifact.");
}

export async function readDependencyInstallRequest(
  workspace: PreparationWorkspace,
): Promise<DependencyInstallRequest | undefined> {
  const result = await workspace.execute(
    readFileCommand(dependencyInstallRequestPath),
  );
  if (result.exitCode !== 0) return undefined;
  const payload = tryParseJson(result.stdout);
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("command" in payload) ||
    typeof payload.command !== "string"
  ) {
    throw new Error("Dependency install tool wrote an invalid request.");
  }
  return payload as DependencyInstallRequest;
}

export async function clearDependencyInstallRequest(
  workspace: PreparationWorkspace,
): Promise<void> {
  const result = await workspace.execute(
    `rm -f ${shellQuote(dependencyInstallRequestPath)}`,
  );
  if (result.exitCode !== 0)
    throw new Error("Failed to clear dependency install request artifact.");
}

function readFileCommand(path: string): string {
  return `if test -f ${shellQuote(path)}; then cat ${shellQuote(path)}; else exit 1; fi`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
