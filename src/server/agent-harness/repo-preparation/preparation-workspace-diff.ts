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
