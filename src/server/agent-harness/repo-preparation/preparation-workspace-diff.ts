/**
 * Backend-observed workspace changes relative to the immutable screened source.
 * `patch` includes tracked, deleted, binary, and untracked files while ignored
 * dependency/build caches remain outside the audit artifact.
 */
export type PreparationWorkspaceDiff = {
  /** SHA-256 of each changed repo-relative file, or null when deleted. */
  changedFileSha256: Record<string, `sha256:${string}` | null>;
  changedPaths: string[];
  patch: string;
  patchSha256: `sha256:${string}`;
  sourceCommitSha: string;
};

/**
 * Normalizes one workspace diff path to its repo-relative form: the sandbox
 * `/workspace/repo` prefix and any leading `./` are stripped. Every consumer
 * comparing diff paths against screened-repository paths must use this key so
 * one spelling cannot pass a check another spelling fails.
 */
export function toRepoRelativePath(path: string): string {
  return path.replace(/^\/workspace\/repo(?:\/|$)/, "").replace(/^\.\//, "");
}
