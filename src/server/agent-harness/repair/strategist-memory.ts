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
 * The durable record of one completed run of a repository. Deterministic
 * code assembles it from the run's own artifacts at run end; the strategist
 * reads it on later runs as advisory history. The one deterministic
 * consumer is the passing `lifecycle`, which round-one evidence may cite
 * verbatim as a proven prior form (N178) — it still grants no authority.
 */
export type StrategistRunMemoryEntry = {
  adviceNotes: StrategistMemoryAdviceNote[];
  finalFailureStage?: string;
  lifecycle?: StrategistMemoryLifecycle;
  outcome: "passed" | "failed";
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
    const lifecycle = entry.lifecycle;
    if (
      typeof lifecycle?.appDir === "string" &&
      typeof lifecycle.installCommandUsed === "string" &&
      typeof lifecycle.startCommandUsed === "string"
    ) {
      return lifecycle;
    }
  }
  return undefined;
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
