import { posix } from "node:path";

const environmentFileNames = new Set([".envrc", ".netrc", ".pgpass"]);
/**
 * Package-manager registry config names screened for embedded credentials.
 * Snapshot readers must read the text of every name in this set: quarantine
 * decides by content, so an unread member would be screened blind.
 */
export const registryConfigFileNames = new Set([
  ".npmrc",
  ".yarnrc",
  // Berry config: the profiler needs its enableScripts policy (N160), and
  // its npmAuthToken/npmAuthIdent entries are credentials like .npmrc's.
  ".yarnrc.yml",
]);
const privateKeyFileNames = new Set([
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);
const privateKeyExtensions = new Set([
  ".jks",
  ".key",
  ".p8",
  ".p12",
  ".pfx",
  ".ppk",
]);
const exampleSuffixPattern = /\.(?:example|sample|template)$/;

function secretFileName(path: string): string {
  return posix.basename(path.replaceAll("\\", "/")).toLowerCase();
}

/** Env-shaped filename that may carry real values; example variants excluded. */
export function isEnvironmentSecretFileName(path: string): boolean {
  const name = secretFileName(path);
  if (exampleSuffixPattern.test(name)) return false;
  return (
    environmentFileNames.has(name) ||
    /^\.env(?:\..+)?$/.test(name) ||
    /.\.env$/.test(name) ||
    name.endsWith(".tfvars")
  );
}

/** Env-family filename including example variants, for env-hint discovery. */
export function isEnvironmentFileName(path: string): boolean {
  const name = secretFileName(path);
  return (
    isEnvironmentSecretFileName(name) ||
    /^\.env(?:\..+)?$/.test(name) ||
    /.\.env\.(?:example|sample|template)$/.test(name)
  );
}

/**
 * Package-manager registry config that carries credentials. Registry-only
 * config is legitimate and required by installs, so the filename alone never
 * condemns it; unreadable content fails closed.
 */
export function isCredentialRegistryConfig(
  path: string,
  text: string | undefined,
): boolean {
  if (!registryConfigFileNames.has(secretFileName(path))) return false;
  if (text === undefined) return true;
  return /_auth|_password|:always-auth|npm_token|npmAuth(?:Token|Ident)/i.test(
    text,
  );
}

/** Filenames that are private-key containers regardless of content. */
export function isPrivateKeyFileName(path: string): boolean {
  const name = secretFileName(path);
  return (
    privateKeyFileNames.has(name) ||
    privateKeyExtensions.has(posix.extname(name))
  );
}

/**
 * Paths worth reading as text for secret inspection even when normally
 * binary. Includes `.pem`, which certificates share with private keys, so
 * content decides rather than the name.
 */
export function isSecretInspectionPath(path: string): boolean {
  return (
    isPrivateKeyFileName(path) || posix.extname(secretFileName(path)) === ".pem"
  );
}

/** Detects PEM, PGP, and PuTTY private-key blocks without matching certificates. */
export function containsPrivateKeyMaterial(text: string | undefined): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-\d/.test(
    text ?? "",
  );
}

/**
 * Extracts the assignment key names from env-style file content — the safe
 * half of a quarantined or example env file that later stages may keep as
 * preparation hints. Values are never returned.
 */
export function readEnvironmentAssignmentKeys(
  text: string | undefined,
): string[] {
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

/**
 * Content fallback for env files under non-env names: every non-comment line
 * is an UPPER_SNAKE assignment with a non-placeholder value, at least three of
 * them. Build files with targets or prose never satisfy the all-lines rule.
 */
export function looksLikeEnvironmentAssignments(
  text: string | undefined,
): boolean {
  if (text === undefined) return false;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length < 3) return false;
  const assignments = lines.filter((line) =>
    /^(?:export\s+)?[A-Z][A-Z0-9_]{2,}=\S/.test(line),
  );
  if (assignments.length !== lines.length) return false;
  const placeholders = assignments.filter((line) =>
    /=["']?(?:x{3,}|changeme|replace|your[-_]|<|\{\{|\$\{)/i.test(line),
  );
  return placeholders.length < assignments.length;
}

/**
 * Normalizes a repository-relative path for security screening: forward
 * slashes only, no leading "./". The quarantine, the static screen, and the
 * profiler must all use this key so a file cannot be quarantined under one
 * spelling and re-admitted under another.
 */
export function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
