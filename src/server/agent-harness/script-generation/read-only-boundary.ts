const allowedMakeADemoFiles = new Set([
  "/workspace/.makeademo/demo-script.json",
  "/workspace/.makeademo/script-candidate.json",
  "/workspace/.makeademo/script-generation-report.json",
  "/workspace/.makeademo/static-script-contract-validation.json",
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

export function assertScriptWritingChangesAllowed(
  changedPaths: string[],
): void {
  const disallowed = changedPaths.filter(
    (path) => !allowedMakeADemoFiles.has(path),
  );
  if (disallowed.length > 0) {
    throw new Error(
      `Script Writing modified disallowed workspace paths: ${disallowed.join(", ")}`,
    );
  }
}
