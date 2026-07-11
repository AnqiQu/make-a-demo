/**
 * Backend-observed workspace changes relative to the immutable screened source.
 * `patch` includes tracked, deleted, binary, and untracked files while ignored
 * dependency/build caches remain outside the audit artifact.
 */
export type PreparationWorkspaceDiff = {
  changedPaths: string[];
  patch: string;
  patchSha256: `sha256:${string}`;
  sourceCommitSha: string;
};
