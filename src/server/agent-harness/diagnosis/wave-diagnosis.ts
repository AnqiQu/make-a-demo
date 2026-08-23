import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { readFailedStage } from "../repair/strategist-memory";

// The diagnostician reads persisted run artifacts of any vintage, so its
// round shape is deliberately its own reduction rather than an import of the
// live RepairRoundLedger type: ledgers, pre-ledger validation attempts, and
// repair candidates all normalize into this before analysis.
type LifecycleExtract = {
  appDir: string | null;
  buildCommandUsed: string | null;
  installCommandUsed: string | null;
  ports: number[];
  startCommandUsed: string | null;
};

type DiagnosisRound = {
  candidateFingerprint: string;
  candidateLifecycle: LifecycleExtract;
  causalHeadline: string;
  failureClassification: string;
  resolvedLifecycle: LifecycleExtract;
  round: number;
  stage: string;
};

type RoundsSource = "ledger" | "reconstructed";

type LifecycleFieldDrop = {
  field: string;
  round: number;
};

type DependencyChain = {
  classification: string;
  headlines: string[];
};

type RepeatedFailure = {
  headline: string;
  roundCount: number;
};

type LastFailure = {
  classification: string;
  headline: string;
};

type RunEntryDiagnosis = {
  dependencyChain?: DependencyChain;
  entryName: string;
  evidenceNotes: string[];
  failedStage?: string;
  fieldDrops: LifecycleFieldDrop[];
  finalReason?: string;
  finalStatus?: string;
  lastFailure?: LastFailure;
  repeatedFailure?: RepeatedFailure;
  rounds: DiagnosisRound[];
  roundsSource?: RoundsSource;
};

/**
 * Drafts the offline wave-diagnosis note for the given completed run entry
 * directories (each `<entry>/artifacts/workspace/.makeademo/...`). The draft
 * is deterministic evidence reduction only — per-entry cause, classification
 * quality flags, and candidate N-item sketches — and must be reviewed by a
 * human before anything enters a remediation plan. Reads never throw on
 * missing or malformed artifacts; absent evidence is reported, not fatal.
 * Runs that predate the repair-round ledger are reconstructed from their
 * validation attempts, repair candidates, and final preparation manifest.
 */
export async function draftWaveDiagnosisNote(
  entryDirectories: readonly string[],
): Promise<string> {
  const diagnoses: RunEntryDiagnosis[] = [];
  for (const entryDirectory of entryDirectories) {
    diagnoses.push(await diagnoseRunEntry(entryDirectory));
  }
  return renderNote(diagnoses);
}

/**
 * Resolves diagnose targets to run entry directories. A path holding
 * `artifacts/workspace/.makeademo` is an entry itself; any other directory
 * is treated as a batch root and contributes its immediate entry
 * subdirectories in name order. Duplicates resolve once; paths holding
 * neither shape contribute nothing.
 */
export async function resolveRunEntryDirectories(
  paths: readonly string[],
): Promise<string[]> {
  const entries: string[] = [];
  const seen = new Set<string>();
  const add = (entryDirectory: string) => {
    const resolved = resolve(entryDirectory);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    entries.push(entryDirectory);
  };
  for (const path of paths) {
    if (await isRunEntryDirectory(path)) {
      add(path);
      continue;
    }
    let children: string[];
    try {
      children = await readdir(path);
    } catch {
      continue;
    }
    for (const child of children.sort()) {
      const childDirectory = join(path, child);
      if (await isRunEntryDirectory(childDirectory)) add(childDirectory);
    }
  }
  return entries;
}

async function isRunEntryDirectory(path: string): Promise<boolean> {
  return await directoryExists(
    join(path, "artifacts", "workspace", ".makeademo"),
  );
}

async function diagnoseRunEntry(
  entryDirectory: string,
): Promise<RunEntryDiagnosis> {
  const makeADemoDirectory = join(
    entryDirectory,
    "artifacts",
    "workspace",
    ".makeademo",
  );
  const evidenceNotes: string[] = [];
  if (!(await directoryExists(makeADemoDirectory))) {
    evidenceNotes.push(
      "No .makeademo artifacts found — the run left no pipeline evidence in this directory.",
    );
  }
  const manifestPath = join(makeADemoDirectory, "pipeline-run-manifest.json");
  const manifest = await readRunManifest(manifestPath);
  const failedStage = await readFailedStage(manifestPath);
  let roundsSource: RoundsSource = "ledger";
  let rounds = await readLedgerRounds(
    join(makeADemoDirectory, "repair-round-ledger.json"),
    evidenceNotes,
  );
  if (rounds.length === 0 && failedStage !== undefined) {
    rounds = await reconstructPreLedgerRounds(makeADemoDirectory, failedStage);
    if (rounds.length > 0) {
      roundsSource = "reconstructed";
      evidenceNotes.push(
        "No repair-round ledger; rounds were reconstructed by pairing each validation attempt with the repair candidate of the same attempt number. The resolved lifecycle is the run's final preparation manifest, not the per-round resolution.",
      );
    }
  }
  const lastFailure =
    readLastRoundFailure(rounds) ??
    (failedStage === undefined
      ? undefined
      : await readLastValidationFailure(makeADemoDirectory, failedStage));
  const dependencyChain = findDependencyChain(rounds);
  const repeatedFailure = findRepeatedFailure(rounds);
  return {
    ...(dependencyChain === undefined ? {} : { dependencyChain }),
    entryName: basename(resolve(entryDirectory)),
    evidenceNotes,
    ...(failedStage === undefined ? {} : { failedStage }),
    fieldDrops: findLifecycleFieldDrops(rounds),
    ...(manifest.finalReason === undefined
      ? {}
      : { finalReason: manifest.finalReason }),
    ...(manifest.finalStatus === undefined
      ? {}
      : { finalStatus: manifest.finalStatus }),
    ...(lastFailure === undefined ? {} : { lastFailure }),
    ...(repeatedFailure === undefined ? {} : { repeatedFailure }),
    rounds,
    ...(rounds.length === 0 ? {} : { roundsSource }),
  };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readRunManifest(
  manifestPath: string,
): Promise<{ finalReason?: string; finalStatus?: string }> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      finalStatus?: unknown;
      unsupportedOrFailureReason?: unknown;
    };
    const finalReason =
      typeof manifest.unsupportedOrFailureReason === "string"
        ? toNoteLine(manifest.unsupportedOrFailureReason)
        : undefined;
    return {
      ...(finalReason === undefined ? {} : { finalReason }),
      ...(typeof manifest.finalStatus === "string"
        ? { finalStatus: manifest.finalStatus }
        : {}),
    };
  } catch {
    return {};
  }
}

async function readLedgerRounds(
  ledgerPath: string,
  evidenceNotes: string[],
): Promise<DiagnosisRound[]> {
  let text: string;
  try {
    text = await readFile(ledgerPath, "utf8");
  } catch {
    return [];
  }
  try {
    const ledger = JSON.parse(text) as { rounds?: unknown };
    if (!Array.isArray(ledger.rounds)) throw new Error("rounds missing");
    return ledger.rounds.flatMap((value) => {
      const round = readLedgerRound(value);
      return round === undefined ? [] : [round];
    });
  } catch {
    evidenceNotes.push(
      "repair-round-ledger.json is present but unreadable — repair-round evidence was skipped.",
    );
    return [];
  }
}

function readLedgerRound(value: unknown): DiagnosisRound | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const round = value as Record<string, unknown>;
  if (
    typeof round.candidateFingerprint !== "string" ||
    typeof round.causalHeadline !== "string" ||
    typeof round.failureClassification !== "string" ||
    typeof round.round !== "number" ||
    typeof round.stage !== "string"
  ) {
    return undefined;
  }
  return {
    candidateFingerprint: round.candidateFingerprint,
    candidateLifecycle: extractLifecycle(round.candidateLifecycle),
    causalHeadline: round.causalHeadline,
    failureClassification: round.failureClassification,
    resolvedLifecycle: extractLifecycle(round.resolvedLifecycle),
    round: round.round,
    stage: round.stage,
  };
}

// Pre-ledger runs (before M1 landed) persisted the same evidence in pieces:
// validation attempt N recorded the failure that opened repair round N, the
// repair candidate of the same attempt number recorded the agent's answer,
// and the final preparation manifest is the only surviving resolution.
async function reconstructPreLedgerRounds(
  makeADemoDirectory: string,
  failedStage: string,
): Promise<DiagnosisRound[]> {
  const resolvedLifecycle = await readJsonLifecycle(
    join(makeADemoDirectory, "preparation-manifest.json"),
  );
  if (resolvedLifecycle === undefined) return [];
  const failures = await readNumberedAttempts(
    join(makeADemoDirectory, "validation-attempts", failedStage),
  );
  const candidates = await readNumberedAttempts(
    join(
      makeADemoDirectory,
      "agent-artifact-attempts",
      "repo-preparation-runtime-repair",
    ),
  );
  const rounds: DiagnosisRound[] = [];
  for (const [attempt, candidateRecord] of candidates) {
    if (candidateRecord.status !== "passed") continue;
    const failure = failures.get(attempt);
    if (typeof failure?.logsSummary !== "string") continue;
    const causalHeadline = firstNonEmptyLine(failure.logsSummary);
    if (causalHeadline === undefined) continue;
    const candidateLifecycle = extractLifecycle(candidateRecord.candidate);
    rounds.push({
      candidateFingerprint: JSON.stringify(candidateLifecycle),
      candidateLifecycle,
      causalHeadline,
      failureClassification:
        typeof failure.failureClassification === "string"
          ? failure.failureClassification
          : "unknown",
      resolvedLifecycle,
      round: attempt,
      stage: typeof failure.stage === "string" ? failure.stage : failedStage,
    });
  }
  return rounds.sort((a, b) => a.round - b.round);
}

async function readNumberedAttempts(
  directory: string,
): Promise<Map<number, Record<string, unknown>>> {
  const attempts = new Map<number, Record<string, unknown>>();
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return attempts;
  }
  for (const name of files) {
    const match = /^attempt-(\d+)\.json$/.exec(name);
    if (match === null) continue;
    try {
      const record = JSON.parse(
        await readFile(join(directory, name), "utf8"),
      ) as unknown;
      if (typeof record === "object" && record !== null) {
        attempts.set(Number(match[1]), record as Record<string, unknown>);
      }
    } catch {
      // A torn attempt file loses one round of evidence, never the draft.
    }
  }
  return attempts;
}

async function readJsonLifecycle(
  manifestPath: string,
): Promise<LifecycleExtract | undefined> {
  try {
    return extractLifecycle(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch {
    return undefined;
  }
}

function extractLifecycle(value: unknown): LifecycleExtract {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const text = (field: unknown) => (typeof field === "string" ? field : null);
  return {
    appDir: text(record.appDir),
    buildCommandUsed: text(record.buildCommandUsed),
    installCommandUsed: text(record.installCommandUsed),
    ports: Array.isArray(record.ports)
      ? record.ports.filter((port): port is number => typeof port === "number")
      : [],
    startCommandUsed: text(record.startCommandUsed),
  };
}

function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

// Every rendered value must stay on its bullet line; multi-line artifact
// prose is reduced to its first line with an elision marker.
function toNoteLine(text: string): string | undefined {
  const firstLine = firstNonEmptyLine(text);
  if (firstLine === undefined) return undefined;
  return firstLine === text.trim() ? firstLine : `${firstLine} […]`;
}

function readLastRoundFailure(
  rounds: readonly DiagnosisRound[],
): LastFailure | undefined {
  const lastRound = rounds[rounds.length - 1];
  if (lastRound === undefined) return undefined;
  return {
    classification: lastRound.failureClassification,
    headline: lastRound.causalHeadline,
  };
}

async function readLastValidationFailure(
  makeADemoDirectory: string,
  failedStage: string,
): Promise<LastFailure | undefined> {
  const attempts = await readNumberedAttempts(
    join(makeADemoDirectory, "validation-attempts", failedStage),
  );
  const lastAttempt = [...attempts.keys()].sort((a, b) => a - b).at(-1);
  if (lastAttempt === undefined) return undefined;
  const attempt = attempts.get(lastAttempt);
  const headline =
    typeof attempt?.logsSummary === "string"
      ? firstNonEmptyLine(attempt.logsSummary)
      : undefined;
  if (headline === undefined) return undefined;
  return {
    classification:
      typeof attempt?.failureClassification === "string"
        ? attempt.failureClassification
        : "unknown",
    headline,
  };
}

const lifecycleFields = [
  "appDir",
  "buildCommandUsed",
  "installCommandUsed",
  "startCommandUsed",
  "ports",
] as const;

function findLifecycleFieldDrops(
  rounds: readonly DiagnosisRound[],
): LifecycleFieldDrop[] {
  const drops: LifecycleFieldDrop[] = [];
  for (const round of rounds) {
    for (const field of lifecycleFields) {
      if (
        hasLifecycleValue(round.candidateLifecycle[field]) &&
        !hasLifecycleValue(round.resolvedLifecycle[field])
      ) {
        drops.push({ field, round: round.round });
      }
    }
  }
  return drops;
}

function hasLifecycleValue(value: string | number[] | null): boolean {
  if (value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return value.trim().length > 0;
}

// A dependency chain: consecutive rounds keep the stage and classification
// while the causal headline and repair candidate both move — each round's
// fix surfaces the next link rather than re-fighting the last one.
function findDependencyChain(
  rounds: readonly DiagnosisRound[],
): DependencyChain | undefined {
  let best: DependencyChain | undefined;
  let chain: string[] = [];
  for (let index = 1; index < rounds.length; index += 1) {
    const previous = rounds[index - 1];
    const current = rounds[index];
    if (previous === undefined || current === undefined) continue;
    const linked =
      current.stage === previous.stage &&
      current.failureClassification === previous.failureClassification &&
      current.causalHeadline !== previous.causalHeadline &&
      current.candidateFingerprint !== previous.candidateFingerprint;
    chain = linked
      ? [
          ...(chain.length > 0 ? chain : [previous.causalHeadline]),
          current.causalHeadline,
        ]
      : [];
    if (chain.length > (best?.headlines.length ?? 0)) {
      best = {
        classification: current.failureClassification,
        headlines: chain,
      };
    }
  }
  return best;
}

// The opposite shape: consecutive rounds reproduce one identical failure,
// so the repairs never reached the recorded cause.
function findRepeatedFailure(
  rounds: readonly DiagnosisRound[],
): RepeatedFailure | undefined {
  let best: RepeatedFailure | undefined;
  let streak = 1;
  for (let index = 1; index < rounds.length; index += 1) {
    const previous = rounds[index - 1];
    const current = rounds[index];
    if (previous === undefined || current === undefined) continue;
    streak =
      current.causalHeadline === previous.causalHeadline &&
      current.failureClassification === previous.failureClassification
        ? streak + 1
        : 1;
    if (streak >= 2 && streak > (best?.roundCount ?? 0)) {
      best = { headline: current.causalHeadline, roundCount: streak };
    }
  }
  return best;
}

function renderNote(diagnoses: readonly RunEntryDiagnosis[]): string {
  const lines: string[] = [
    "# Wave diagnosis (draft — review before entering the plan)",
    "",
  ];
  for (const diagnosis of diagnoses) {
    lines.push(`## ${diagnosis.entryName}`, "");
    lines.push(...renderEntry(diagnosis), "");
  }
  lines.push("## Candidate N-item sketches", "");
  const sketches = renderSketches(diagnoses);
  lines.push(...(sketches.length > 0 ? sketches : ["None."]), "");
  return lines.join("\n");
}

function renderEntry(diagnosis: RunEntryDiagnosis): string[] {
  const lines: string[] = [];
  const outcome = diagnosis.finalStatus ?? "unknown";
  lines.push(
    diagnosis.failedStage === undefined
      ? `- Outcome: ${outcome}`
      : `- Outcome: ${outcome} (failed stage: ${diagnosis.failedStage})`,
  );
  if (diagnosis.finalReason !== undefined) {
    lines.push(`- Final reason: ${diagnosis.finalReason}`);
  }
  if (diagnosis.lastFailure !== undefined) {
    lines.push(
      `- Last failure: ${diagnosis.lastFailure.headline} [classification: ${diagnosis.lastFailure.classification}]`,
    );
  }
  if (diagnosis.rounds.length > 0) {
    lines.push(
      diagnosis.roundsSource === "reconstructed"
        ? `- Repair rounds (reconstructed from pre-ledger artifacts): ${diagnosis.rounds.length}`
        : `- Repair rounds in ledger: ${diagnosis.rounds.length}`,
    );
  }
  lines.push(...renderClassificationQuality(diagnosis));
  for (const drop of diagnosis.fieldDrops) {
    lines.push(
      `- Finding: \`${drop.field}\` was dropped between the candidate and resolved manifests in round ${drop.round} — the candidate declared it and resolution discarded it.`,
    );
  }
  if (diagnosis.dependencyChain !== undefined) {
    lines.push(
      `- Finding: dependency-chain shape — ${diagnosis.dependencyChain.headlines.length} consecutive "${diagnosis.dependencyChain.classification}" rounds each surfaced the next link:`,
      ...diagnosis.dependencyChain.headlines.map(
        (headline, index) => `  ${index + 1}. ${headline}`,
      ),
    );
  }
  if (diagnosis.repeatedFailure !== undefined) {
    lines.push(
      `- Finding: ${diagnosis.repeatedFailure.roundCount} rounds reproduced an identical failure — the repairs never reached the recorded cause.`,
    );
  }
  for (const evidenceNote of diagnosis.evidenceNotes) {
    lines.push(`- Evidence note: ${evidenceNote}`);
  }
  return lines;
}

function renderClassificationQuality(diagnosis: RunEntryDiagnosis): string[] {
  const flags: string[] = [];
  for (const drop of diagnosis.fieldDrops) {
    const round = diagnosis.rounds.find((entry) => entry.round === drop.round);
    flags.push(
      `round ${drop.round} was classified "${round?.failureClassification ?? "unknown"}" as if the manifest lacked \`${drop.field}\`, but the candidate declared it — the value was lost after resolution, so the classification points at the agent instead of the resolver.`,
    );
  }
  if (diagnosis.dependencyChain !== undefined) {
    flags.push(
      `classification "${diagnosis.dependencyChain.classification}" stayed stable while the failing subject moved each round — consistent with a dependency chain, not with repair regressions.`,
    );
  }
  if (flags.length === 0) {
    return diagnosis.rounds.length > 0
      ? [
          "- Classification quality: no contradictions between recorded classifications and ledger evidence.",
        ]
      : [];
  }
  return flags.map((flag) => `- Classification quality: ${flag}`);
}

function renderSketches(diagnoses: readonly RunEntryDiagnosis[]): string[] {
  const sketches: string[] = [];
  const droppedEntries = diagnoses.filter(
    (diagnosis) => diagnosis.fieldDrops.length > 0,
  );
  if (droppedEntries.length > 0) {
    const fields = [
      ...new Set(
        droppedEntries.flatMap((diagnosis) =>
          diagnosis.fieldDrops.map((drop) => `\`${drop.field}\``),
        ),
      ),
    ];
    const entryNames = droppedEntries
      .map((diagnosis) => diagnosis.entryName)
      .join(", ");
    sketches.push(
      `Preserve candidate lifecycle fields through manifest resolution: ${fields.join(", ")} dropped between candidate and resolved manifests (${entryNames}). Locate and fix the resolver seam that discards the value.`,
    );
  }
  const chainEntries = diagnoses.filter(
    (diagnosis) => diagnosis.dependencyChain !== undefined,
  );
  if (chainEntries.length > 0) {
    const entryNames = chainEntries
      .map((diagnosis) => diagnosis.entryName)
      .join(", ");
    sketches.push(
      `Resolve the whole dependency chain in one repair round instead of one link per round (${entryNames}): each fix surfaced the next same-classification failure, spending a full round per link.`,
    );
  }
  const repeatedEntries = diagnoses.filter(
    (diagnosis) => diagnosis.repeatedFailure !== undefined,
  );
  if (repeatedEntries.length > 0) {
    const entryNames = repeatedEntries
      .map((diagnosis) => diagnosis.entryName)
      .join(", ");
    sketches.push(
      `Detect repair rounds that reproduce an identical failure and escalate or stop sooner (${entryNames}): identical causal headlines across rounds mean the loop spent budget without progress.`,
    );
  }
  return sketches.map((sketch, index) => `${index + 1}. ${sketch}`);
}
