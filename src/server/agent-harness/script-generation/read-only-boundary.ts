import { makeADemoArtifactPaths } from "../schemas/artifact-paths";

// Script Writing may change its own artifacts (agent-written demo script,
// backend-written candidate and static-contract report) and nothing else.
const allowedMakeADemoFiles = new Set<string>([
  makeADemoArtifactPaths.demoScript,
  makeADemoArtifactPaths.scriptCandidate,
  makeADemoArtifactPaths.staticScriptContract,
]);

/**
 * A path-to-content-fingerprint snapshot of the submitted workspace. Callers
 * must fingerprint both tracked and untracked files so changes to files that
 * were already dirty before Script Writing remain observable.
 */
export type ScriptWritingContentSnapshot = Readonly<Record<string, string>>;

/**
 * Returns paths whose content identity was added, removed, or changed between
 * the Script Writing boundaries. Fingerprints are opaque to this module.
 */
export function findScriptWritingContentChanges(input: {
  after: ScriptWritingContentSnapshot;
  before: ScriptWritingContentSnapshot;
}): string[] {
  const paths = new Set([
    ...Object.keys(input.before),
    ...Object.keys(input.after),
  ]);
  return [...paths]
    .filter((path) => input.before[path] !== input.after[path])
    .sort();
}

/**
 * Returns changed paths outside the demo-script artifact allowlist. Callers
 * turn a non-empty result into a routable "script modified app source"
 * validation failure rather than crashing the pipeline.
 */
export function readDisallowedScriptWritingChanges(
  changedPaths: string[],
): string[] {
  return changedPaths.filter((path) => !allowedMakeADemoFiles.has(path));
}
