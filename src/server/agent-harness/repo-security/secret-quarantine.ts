import {
  containsPrivateKeyMaterial,
  isCredentialRegistryConfig,
  isEnvironmentSecretFileName,
  isPrivateKeyFileName,
  looksLikeEnvironmentAssignments,
  normalizeRepoPath,
  readEnvironmentAssignmentKeys,
} from "./secret-predicates";

const secretQuarantineManifestVersion = "2026-07-15" as const;

type SecretQuarantineEntry = {
  environmentKeys?: string[];
  kind: "environment-file" | "private-key-file";
  path: string;
};

export type SecretQuarantineManifest = {
  entries: SecretQuarantineEntry[];
  version: typeof secretQuarantineManifestVersion;
};

type RepoFile = { path: string; symlinkTarget?: string; text?: string };

/**
 * Removes credential-bearing file contents from the repository view and marks
 * the complete files for omission from the archive used by agents and runtime.
 */
export function quarantineRepoSecrets(files: RepoFile[]): {
  excludedPaths: string[];
  files: RepoFile[];
  manifest: SecretQuarantineManifest;
} {
  const entries = files.flatMap((file): SecretQuarantineEntry[] => {
    const path = normalizeRepoPath(file.path);
    if (
      isEnvironmentSecretFileName(path) ||
      isCredentialRegistryConfig(path, file.text) ||
      looksLikeEnvironmentAssignments(file.text)
    ) {
      const environmentKeys = readEnvironmentAssignmentKeys(file.text);
      return [
        {
          ...(environmentKeys.length === 0 ? {} : { environmentKeys }),
          kind: "environment-file",
          path,
        },
      ];
    }
    if (containsPrivateKeyMaterial(file.text) || isPrivateKeyFileName(path)) {
      return [{ kind: "private-key-file", path }];
    }
    return [];
  });
  const quarantinedPaths = new Set(entries.map((entry) => entry.path));
  return {
    excludedPaths: [...quarantinedPaths].sort(),
    files: files.map((file) => {
      const path = normalizeRepoPath(file.path);
      return quarantinedPaths.has(path) ? { path } : { ...file, path };
    }),
    manifest: {
      entries: entries.sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
      version: secretQuarantineManifestVersion,
    },
  };
}
