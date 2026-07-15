import { posix } from "node:path";

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
    const path = normalizePath(file.path);
    if (isPrivateEnvironmentFile(path)) {
      const environmentKeys = readEnvironmentKeys(file.text);
      return [
        {
          ...(environmentKeys.length === 0 ? {} : { environmentKeys }),
          kind: "environment-file",
          path,
        },
      ];
    }
    if (
      containsPrivateKeyMaterial(file.text) ||
      isDedicatedPrivateKeyPath(path)
    ) {
      return [{ kind: "private-key-file", path }];
    }
    return [];
  });
  const quarantinedPaths = new Set(entries.map((entry) => entry.path));
  return {
    excludedPaths: [...quarantinedPaths].sort(),
    files: files.map((file) => {
      const path = normalizePath(file.path);
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

/** Returns whether the snapshot reader should inspect a normally-binary path. */
export function isSecretCandidatePath(path: string): boolean {
  const filename = posix.basename(normalizePath(path)).toLowerCase();
  const extension = posix.extname(filename);
  return (
    filename === "id_ed25519" ||
    filename === "id_rsa" ||
    [".key", ".p12", ".pem", ".pfx"].includes(extension)
  );
}

function isPrivateEnvironmentFile(path: string): boolean {
  const filename = posix.basename(path).toLowerCase();
  if (!/^\.env(?:\..+)?$/.test(filename)) return false;
  return !/\.(?:example|sample|template)$/.test(filename);
}

function readEnvironmentKeys(text: string | undefined): string[] {
  if (text === undefined) return [];
  return [
    ...new Set(
      text
        .split("\n")
        .map(
          (line) =>
            /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1],
        )
        .filter((key): key is string => key !== undefined),
    ),
  ].sort();
}

/** Detects PEM and OpenSSH private-key blocks without matching certificates. */
export function containsPrivateKeyMaterial(text: string | undefined): boolean {
  return /-----BEGIN (?:(?:OPENSSH|RSA|DSA|EC|ENCRYPTED) )?PRIVATE KEY-----/.test(
    text ?? "",
  );
}

function isDedicatedPrivateKeyPath(path: string): boolean {
  const filename = posix.basename(path).toLowerCase();
  const extension = posix.extname(filename);
  if (filename === "id_ed25519" || filename === "id_rsa") return true;
  return extension === ".key" || extension === ".p12" || extension === ".pfx";
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
