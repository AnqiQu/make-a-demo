import semver from "semver";

/**
 * Node LTS lines baked into the submitted-code image as swappable tarballs.
 * The Dockerfile content test keeps the image layers in sync with this list;
 * growing a line means one entry here plus one tarball layer there.
 */
export const SUPPORTED_NODE_LINES = [20, 22, 24] as const;

/** Line used when the repository declares no Node pin at all. */
export const DEFAULT_NODE_LINE = 24;

export type NodeLineResolution = {
  line: number;
  /** Human-readable pin sources that produced the decision. */
  provenance: string[];
  /** False when no baked line satisfies every discovered pin. */
  satisfied: boolean;
};

type NodePinConstraint = {
  range: string;
  source: string;
};

/**
 * Resolves which baked Node line the submitted-code sandbox must run for a
 * screened repository. Reads `engines.node`, `devEngines.runtime`, `.nvmrc`,
 * and `.node-version` from the repo root and the locked runtime target
 * directory. Selection is the highest supported line intersecting every
 * discovered pin; when pins conflict, the root's install-governing pins win;
 * when no supported line satisfies them, the nearest line is chosen and
 * `satisfied: false` recorded so a later preflight failure self-explains.
 * The function is total: unreadable manifests and unparseable pins are
 * skipped, never thrown.
 */
export function resolveNodeLine(input: {
  files: Array<{ path: string; text?: string }>;
  targetId?: string;
}): NodeLineResolution {
  const rootConstraints = readNodePinConstraints(input.files, "");
  const targetDir =
    input.targetId === undefined ||
    input.targetId === "." ||
    input.targetId === ""
      ? undefined
      : input.targetId;
  const targetConstraints =
    targetDir === undefined
      ? []
      : readNodePinConstraints(input.files, `${targetDir}/`);
  const constraints = [...rootConstraints, ...targetConstraints];
  if (constraints.length === 0) {
    return {
      line: DEFAULT_NODE_LINE,
      provenance: ["default (no repository Node pin)"],
      satisfied: true,
    };
  }
  const all = highestLineSatisfying(constraints);
  if (all !== undefined) {
    return {
      line: all,
      provenance: constraints.map(({ source }) => source),
      satisfied: true,
    };
  }
  const rootOnly =
    rootConstraints.length === 0
      ? undefined
      : highestLineSatisfying(rootConstraints);
  if (rootOnly !== undefined) {
    return {
      line: rootOnly,
      provenance: constraints.map(({ source }) => source),
      satisfied: false,
    };
  }
  return {
    line: nearestLineTo(rootConstraints[0] ?? constraints[0]),
    provenance: constraints.map(({ source }) => source),
    satisfied: false,
  };
}

/**
 * Builds the shell command that swaps the submitted-code sandbox's
 * `/usr/local` Node to a baked line. Idempotent via the image's line marker;
 * fails with a rebuild instruction (never a shell exit, which would drop the
 * PTY exit sentinel) when the line is not baked. Re-runs `corepack enable`
 * because the manager shims live in the swapped bin directory.
 */
export function createNodeLineSwapCommand(line: number): string {
  const marker = "/usr/local/.makeademo-node-line";
  return [
    `if [ "$(cat ${marker} 2>/dev/null)" = "${line}" ]; then node --version;`,
    `elif tarball="$(ls /opt/node-lines/node-v${line}.*-linux-x64.tar.gz 2>/dev/null | head -n 1)" && [ -n "$tarball" ]; then`,
    "rm -rf /usr/local/include/node /usr/local/lib/node_modules &&",
    "rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack &&",
    'tar -xzf "$tarball" -C /usr/local --strip-components=1 &&',
    "corepack enable &&",
    `echo "${line}" > ${marker} && node --version;`,
    `else echo "makeademo: node line ${line} is not baked into this image; rebuild the submitted-code snapshot" >&2 && false; fi`,
  ].join(" ");
}

function readNodePinConstraints(
  files: Array<{ path: string; text?: string }>,
  prefix: string,
): NodePinConstraint[] {
  const read = (path: string): string | undefined =>
    files.find((file) => file.path === `${prefix}${path}`)?.text;
  const constraints: NodePinConstraint[] = [];
  const manifestText = read("package.json");
  if (manifestText !== undefined) {
    const manifest = tryParseJsonRecord(manifestText);
    const enginesNode = readStringAt(manifest, ["engines", "node"]);
    if (enginesNode !== undefined) {
      pushConstraint(
        constraints,
        enginesNode,
        `${prefix}package.json engines.node "${enginesNode}"`,
      );
    }
    for (const version of readDevEnginesNodeVersions(manifest)) {
      pushConstraint(
        constraints,
        version,
        `${prefix}package.json devEngines node "${version}"`,
      );
    }
  }
  for (const versionFile of [".nvmrc", ".node-version"]) {
    const raw = read(versionFile)?.trim().replace(/^v/, "");
    if (raw !== undefined && raw.length > 0) {
      pushConstraint(constraints, raw, `${prefix}${versionFile} ${raw}`);
    }
  }
  return constraints;
}

function pushConstraint(
  constraints: NodePinConstraint[],
  raw: string,
  source: string,
): void {
  const range = semver.validRange(raw);
  if (range !== null) {
    constraints.push({ range, source });
  }
}

function readDevEnginesNodeVersions(
  manifest: Record<string, unknown> | undefined,
): string[] {
  const runtime = (manifest?.devEngines as Record<string, unknown> | undefined)
    ?.runtime;
  const entries = Array.isArray(runtime) ? runtime : [runtime];
  return entries.flatMap((entry) => {
    const record = entry as Record<string, unknown> | undefined;
    return record?.name === "node" && typeof record.version === "string"
      ? [record.version]
      : [];
  });
}

function highestLineSatisfying(
  constraints: NodePinConstraint[],
): number | undefined {
  return [...SUPPORTED_NODE_LINES]
    .reverse()
    .find((line) =>
      constraints.every(({ range }) =>
        semver.intersects(lineRange(line), range),
      ),
    );
}

function nearestLineTo(constraint: NodePinConstraint | undefined): number {
  const pinnedMajor =
    constraint === undefined
      ? undefined
      : semver.minVersion(constraint.range)?.major;
  if (pinnedMajor === undefined) {
    return DEFAULT_NODE_LINE;
  }
  return [...SUPPORTED_NODE_LINES].sort(
    (left, right) =>
      Math.abs(left - pinnedMajor) - Math.abs(right - pinnedMajor) ||
      right - left,
  )[0] as number;
}

function lineRange(line: number): string {
  return `>=${line}.0.0 <${line + 1}.0.0`;
}

function tryParseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readStringAt(
  record: Record<string, unknown> | undefined,
  path: [string, string],
): string | undefined {
  const nested = record?.[path[0]] as Record<string, unknown> | undefined;
  const value = nested?.[path[1]];
  return typeof value === "string" ? value : undefined;
}
