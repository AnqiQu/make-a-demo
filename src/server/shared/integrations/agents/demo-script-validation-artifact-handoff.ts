import type { PreparationWorkspace } from "../../../pipeline/03-repo-preparation/preparation-workspace.interface";
import { tryParseJson } from "./makeademo-opencode-tool-protocol";

export const demoScriptPath = "/workspace/.makeademo/demo-script.json";

export async function readDemoScriptArtifact(
  workspace: PreparationWorkspace,
  path: string = demoScriptPath,
): Promise<unknown> {
  if (path !== demoScriptPath) {
    throw new Error(`Demo Script path must be ${demoScriptPath}.`);
  }
  const result = await workspace.execute(readFileCommand(path));
  if (result.exitCode !== 0) {
    throw new Error(`Demo Script artifact ${path} is missing.`);
  }
  const value = tryParseJson(result.stdout);
  if (value === undefined) {
    throw new Error(`Demo Script artifact ${path} contains invalid JSON.`);
  }
  return value;
}

function readFileCommand(path: string): string {
  return `if test -f ${shellQuote(path)}; then cat ${shellQuote(path)}; else exit 1; fi`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
