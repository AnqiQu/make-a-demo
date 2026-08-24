// The managers corepack materializes. A floating bun or exotic selector
// never triggers a corepack registry fetch, so it is not repo state this
// module needs to police.
const corepackManagedManagers = new Set(["npm", "pnpm", "yarn"]);

// An exact, offline-materializable version: <major>.<minor>.<patch> with
// optional prerelease and integrity/build suffixes ("9.0.0-rc.2",
// "4.5.0+sha224.…"). Anything else — a bare major, a range, a dist-tag, or
// no version at all — makes corepack resolve the selector against the
// registry on every invocation.
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+.+)?$/;

/**
 * Reads a package.json text and returns its packageManager declaration when
 * — and only when — it is a floating selector corepack must resolve against
 * the npm registry at invocation time (N175: homer's "pnpm@10" wore a
 * network costume for five repair rounds). Returns undefined for exact
 * pins, managers corepack does not materialize, absent or non-string
 * fields, and unparseable JSON — the caller treats every undefined as
 * "nothing to flag" and lets the real lifecycle produce its own evidence.
 */
export function readFloatingPackageManagerSelector(
  packageJsonText: string,
): { manager: string; selector: string } | undefined {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(packageJsonText);
  } catch {
    return undefined;
  }
  if (typeof packageJson !== "object" || packageJson === null) {
    return undefined;
  }
  const selector = (packageJson as { packageManager?: unknown }).packageManager;
  if (typeof selector !== "string" || selector.trim().length === 0) {
    return undefined;
  }
  const trimmed = selector.trim();
  const atIndex = trimmed.indexOf("@");
  const manager = atIndex === -1 ? trimmed : trimmed.slice(0, atIndex);
  const version = atIndex === -1 ? "" : trimmed.slice(atIndex + 1);
  if (!corepackManagedManagers.has(manager)) {
    return undefined;
  }
  if (exactVersionPattern.test(version)) {
    return undefined;
  }
  return { manager, selector: trimmed };
}

/**
 * True when any of the given lifecycle commands invokes the manager as a
 * command token ("pnpm install", "corepack enable && pnpm run build",
 * "FOO=1 pnpm start"), which is what routes the invocation through the
 * corepack shim. Substring hits inside scopes or flags ("--filter=@pnpm/x")
 * do not count. Null and undefined commands are skipped so callers can pass
 * optional manifest fields directly.
 */
export function commandsInvokePackageManager(
  commands: readonly (string | null | undefined)[],
  manager: string,
): boolean {
  return commands.some((command) =>
    (command ?? "").split(/[\s;&|()<>]+/).some((token) => token === manager),
  );
}
