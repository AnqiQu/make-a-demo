import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * One strategist recommendation as remembered across runs: the kind, the
 * prose it carried (hint, directive, or reason), and the memo the strategist
 * chose to persist for its future consultations on this repository.
 */
export type StrategistMemoryAdviceNote = {
  kind: string;
  memo?: string;
  text?: string;
};

/**
 * The resolved lifecycle a passing run demonstrated, recorded in the run
 * digest so later runs can compare their declared commands against a form
 * proven to work (N178: midday's regression burned five rounds on a
 * filtered install while the digest's outcome line silently knew the last
 * pass installed unfiltered). Field names mirror the Preparation Manifest;
 * data-strategy entries keep only their command surface.
 */
export type StrategistMemoryLifecycle = {
  appDir: string;
  buildCommandUsed?: string;
  dataStrategy?: {
    migrationCommand?: string;
    rung: string;
    seedCommand?: string;
    service: string;
  }[];
  installCommandUsed: string;
  startCommandUsed: string;
};

/**
 * One proof a passing run grounded: the feature, the declared proof target
 * in the maker's vocabulary ("INV-1042", never a fixture file), and the
 * route where verification observed it (N184: midday re-rolled the fixture
 * content its own last pass had right, and no memory surface recorded what
 * "right" looked like).
 */
export type StrategistMemoryProofAnchor = {
  featureId: string;
  proof: string;
  route: string;
};

/**
 * The durable record of one completed run of a repository. Deterministic
 * code assembles it from the run's own artifacts at run end; the strategist
 * reads it on later runs as advisory history. The deterministic consumers
 * are the passing `lifecycle`, which round-one evidence may cite verbatim
 * as a proven prior form (N178); the failed run's `lifecycleFragment` —
 * the last lifecycle whose repair declaration moved this run's failure —
 * which evidence cites only while no pass is recorded (N179); and the
 * passing `proofAnchors`, which round-one evidence cites when a content
 * failure needs the last pass's grounded proofs named (N184). None grants
 * authority.
 */
export type StrategistRunMemoryEntry = {
  adviceNotes: StrategistMemoryAdviceNote[];
  finalFailureStage?: string;
  lifecycle?: StrategistMemoryLifecycle;
  lifecycleFragment?: StrategistMemoryLifecycle;
  outcome: "passed" | "failed";
  proofAnchors?: StrategistMemoryProofAnchor[];
  recordedAt: string;
  runId: string;
};

/**
 * Cross-run memory for the strategist, keyed by repository identity.
 * Implementations must be append-only (history is evidence; nothing may
 * rewrite it) and must never throw run-relevant state away on a torn or
 * corrupt record: reads skip what they cannot parse. Neither operation may
 * be load-bearing for a run — callers treat every failure as "no memory".
 */
export interface StrategistMemoryStore {
  append(input: {
    entry: StrategistRunMemoryEntry;
    repoUrl: string;
  }): Promise<void>;
  readRecent(input: {
    limit: number;
    repoUrl: string;
  }): Promise<StrategistRunMemoryEntry[]>;
}

/**
 * File-backed store: one append-only JSONL log per normalized repository
 * under `directory`. Suits the terminal matrix workflow, where the output
 * root outlives individual runs on the same machine.
 */
export function createFileStrategistMemoryStore(options: {
  directory: string;
}): StrategistMemoryStore {
  const logPath = (repoUrl: string) =>
    join(options.directory, `${strategistMemoryRepoKey(repoUrl)}.jsonl`);
  return {
    async append(input) {
      await mkdir(options.directory, { recursive: true });
      await appendFile(
        logPath(input.repoUrl),
        `${JSON.stringify(input.entry)}\n`,
      );
    },
    async readRecent(input) {
      let text: string;
      try {
        text = await readFile(logPath(input.repoUrl), "utf8");
      } catch {
        return [];
      }
      const entries = text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          try {
            const value = JSON.parse(line) as StrategistRunMemoryEntry;
            return isMemoryEntry(value) ? [value] : [];
          } catch {
            return [];
          }
        });
      return entries.slice(-input.limit);
    },
  };
}

function isMemoryEntry(value: unknown): value is StrategistRunMemoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.adviceNotes) &&
    (record.outcome === "passed" || record.outcome === "failed") &&
    typeof record.runId === "string"
  );
}

function strategistMemoryRepoKey(repoUrl: string): string {
  return repoUrl
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Reduces a resolved Preparation Manifest to the digest's lifecycle
 * record: the commands and app directory a passing run demonstrated,
 * nothing else. Structural on purpose so this module keeps no schema
 * imports; data-strategy entries are stripped to their command surface.
 */
export function toStrategistMemoryLifecycle(manifest: {
  appDir: string;
  buildCommandUsed?: string;
  dataStrategy?: readonly {
    detail?: string;
    migrationCommand?: string;
    rung: string;
    seedCommand?: string;
    service: string;
  }[];
  installCommandUsed: string;
  startCommandUsed: string;
}): StrategistMemoryLifecycle {
  return {
    appDir: manifest.appDir,
    ...(manifest.buildCommandUsed === undefined
      ? {}
      : { buildCommandUsed: manifest.buildCommandUsed }),
    ...(manifest.dataStrategy === undefined
      ? {}
      : {
          dataStrategy: manifest.dataStrategy.map((entry) => ({
            ...(entry.migrationCommand === undefined
              ? {}
              : { migrationCommand: entry.migrationCommand }),
            rung: entry.rung,
            ...(entry.seedCommand === undefined
              ? {}
              : { seedCommand: entry.seedCommand }),
            service: entry.service,
          })),
        }),
    installCommandUsed: manifest.installCommandUsed,
    startCommandUsed: manifest.startCommandUsed,
  };
}

/**
 * The declared-proof vocabulary a feature can anchor on. Structural on
 * purpose: the schema's ExpectedProof union satisfies it, and a kind added
 * there surfaces here as a compile error at the reducer's call site rather
 * than a silently dropped anchor.
 */
type DeclaredProofTarget =
  | { contains: string; key: string; kind: "app-state"; source: string }
  | { kind: "canvas-delta"; locator: string }
  | { kind: "element-appears"; name: string }
  | { from: string; kind: "state-transition"; locator: string; to: string }
  | { kind: "visible-text"; text: string };

/**
 * Reduces a passing run's verification artifacts to the digest's proof
 * anchors: for each feature the run grounded, the declared proof target
 * rendered in the maker's vocabulary and the route the verdict's evidence
 * grounded it on (catalog action routes first, the feature's first entry
 * path as fallback — the same derivation exploration prose uses). Features
 * without a declared proof are skipped: an anchor names what a later
 * preparation must reproduce, and only declared proofs carry that
 * vocabulary (N184). Structural on purpose so this module keeps no schema
 * imports.
 */
export function toStrategistMemoryProofAnchors(input: {
  actionCatalogActions?: readonly { id: string; route: string }[];
  featureInventory: readonly {
    entryPaths: readonly string[];
    expectedProof?: DeclaredProofTarget;
    id: string;
  }[];
  featureVerdicts: readonly {
    evidence?: readonly string[];
    featureId: string;
    verdict: string;
  }[];
}): StrategistMemoryProofAnchor[] {
  const routeByActionId = new Map(
    (input.actionCatalogActions ?? []).map((action) => [
      action.id,
      action.route,
    ]),
  );
  const anchors: StrategistMemoryProofAnchor[] = [];
  for (const verdict of input.featureVerdicts) {
    if (verdict.verdict !== "grounded") {
      continue;
    }
    const feature = input.featureInventory.find(
      (candidate) => candidate.id === verdict.featureId,
    );
    if (feature?.expectedProof === undefined) {
      continue;
    }
    const route =
      (verdict.evidence ?? [])
        .map((actionId) => routeByActionId.get(actionId))
        .find((candidate) => candidate !== undefined) ?? feature.entryPaths[0];
    if (route === undefined) {
      continue;
    }
    anchors.push({
      featureId: feature.id,
      proof: describeDeclaredProof(feature.expectedProof),
      route,
    });
  }
  return anchors;
}

function describeDeclaredProof(proof: DeclaredProofTarget): string {
  switch (proof.kind) {
    case "app-state":
      return `app state ${proof.source}.${proof.key} contains ${JSON.stringify(proof.contains)}`;
    case "canvas-delta":
      return `canvas at ${JSON.stringify(proof.locator)} changes`;
    case "element-appears":
      return `element ${JSON.stringify(proof.name)} appears`;
    case "state-transition":
      return `${JSON.stringify(proof.locator)} transitions from ${JSON.stringify(proof.from)} to ${JSON.stringify(proof.to)}`;
    case "visible-text":
      return `visible text ${JSON.stringify(proof.text)}`;
  }
}

/**
 * Reads the most recent passing run's recorded lifecycle from memory
 * entries (oldest first, as `readRecent` returns them). Failed runs,
 * digests that predate the lifecycle field, and malformed persisted
 * lifecycles are all skipped — undefined means "no proven prior form",
 * and callers must present nothing rather than something reconstructed.
 */
export function readLastPassingLifecycle(
  entries: readonly StrategistRunMemoryEntry[],
): StrategistMemoryLifecycle | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.outcome !== "passed") {
      continue;
    }
    if (isLifecycleRecord(entry.lifecycle)) {
      return entry.lifecycle;
    }
  }
  return undefined;
}

/**
 * Reads the most recent passing run's recorded proof anchors from memory
 * entries (oldest first, as `readRecent` returns them). Failed runs,
 * anchor-less passes, and malformed persisted anchors are all skipped —
 * undefined means "no grounded prior content to cite", and callers must
 * present nothing rather than something reconstructed (N184).
 */
export function readLastPassingProofAnchors(
  entries: readonly StrategistRunMemoryEntry[],
): StrategistMemoryProofAnchor[] | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.outcome !== "passed") {
      continue;
    }
    const anchors = (entry.proofAnchors ?? []).filter(isProofAnchorRecord);
    if (anchors.length > 0) {
      return anchors;
    }
  }
  return undefined;
}

function isProofAnchorRecord(
  value: unknown,
): value is StrategistMemoryProofAnchor {
  const anchor = value as StrategistMemoryProofAnchor | undefined;
  return (
    typeof anchor?.featureId === "string" &&
    typeof anchor.proof === "string" &&
    typeof anchor.route === "string"
  );
}

/**
 * Reads the most recent known-good lifecycle fragment from memory entries:
 * the closest a never-passing repository has come, recorded by failed runs
 * whose repair declaration moved the failure (N179: twenty rediscovered
 * its nx graph build in round 4 three waves running and reverted it in
 * round 5). Passing runs' lifecycles are deliberately not read here —
 * callers cite fragments only while no pass is recorded — and malformed
 * fragments read as absent, never as reconstructed forms.
 */
export function readLastLifecycleFragment(
  entries: readonly StrategistRunMemoryEntry[],
): StrategistMemoryLifecycle | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isLifecycleRecord(entry?.lifecycleFragment)) {
      return entry.lifecycleFragment;
    }
  }
  return undefined;
}

/**
 * Best-effort read of the run's mirrored failure-moved lifecycle artifact:
 * the last lifecycle whose repair declaration moved this run's preparation
 * failure, written by the harness as rounds complete (N179). A missing or
 * malformed artifact means "this run moved nothing" — never an error.
 */
export async function readFailureMovedLifecycle(
  failureMovedLifecyclePath: string,
): Promise<StrategistMemoryLifecycle | undefined> {
  try {
    const record = JSON.parse(
      await readFile(failureMovedLifecyclePath, "utf8"),
    ) as { lifecycle?: unknown };
    return isLifecycleRecord(record.lifecycle) ? record.lifecycle : undefined;
  } catch {
    return undefined;
  }
}

function isLifecycleRecord(value: unknown): value is StrategistMemoryLifecycle {
  const lifecycle = value as StrategistMemoryLifecycle | undefined;
  return (
    typeof lifecycle?.appDir === "string" &&
    typeof lifecycle.installCommandUsed === "string" &&
    typeof lifecycle.startCommandUsed === "string"
  );
}

/**
 * Reads the run's persisted repair-strategy attempt artifacts into memory
 * notes: passed consultations only, in attempt order, each reduced to kind,
 * prose, and memo. Missing directories mean the run never consulted.
 */
export async function readStrategistAdviceNotes(
  agentArtifactAttemptsDirectory: string,
): Promise<StrategistMemoryAdviceNote[]> {
  const directory = join(agentArtifactAttemptsDirectory, "repair-strategy");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return [];
  }
  const attempts = files
    .map((name) => /^attempt-(\d+)\.json$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const notes: StrategistMemoryAdviceNote[] = [];
  for (const match of attempts) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(
        await readFile(join(directory, match[0]), "utf8"),
      ) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.status !== "passed") continue;
    const advice = record.advice as Record<string, unknown> | undefined;
    if (typeof advice?.kind !== "string") continue;
    const text = advice.hint ?? advice.directive ?? advice.reason;
    notes.push({
      kind: advice.kind,
      ...(typeof advice.memo === "string" ? { memo: advice.memo } : {}),
      ...(typeof text === "string" ? { text } : {}),
    });
  }
  return notes;
}

/**
 * Best-effort read of the failed stage name from a mirrored run manifest,
 * for the memory entry's headline. Absence of the manifest, of statuses, or
 * of a failure all mean undefined — never an error.
 */
export async function readFailedStage(
  pipelineRunManifestPath: string,
): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(pipelineRunManifestPath, "utf8"),
    ) as { stageStatuses?: Record<string, unknown> };
    return Object.entries(manifest.stageStatuses ?? {}).find(
      ([, status]) => status === "failed",
    )?.[0];
  } catch {
    return undefined;
  }
}
