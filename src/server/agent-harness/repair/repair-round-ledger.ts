import { toRepoRelativePath } from "../repo-preparation/preparation-workspace-diff";
import type { RepairAdvice } from "../schemas/repair-advice.schema";

type RepairLifecycle = {
  appDir: string;
  buildCommandUsed?: string | null;
  installCommandUsed: string;
  ports: number[];
  startCommandUsed: string;
};

export type RepairBudgetSnapshot = {
  bonusRounds: number;
  fingerprintAttempts: number;
  totalAttempts: number;
};

type RepairRoundAdviceRecord = {
  applied: boolean;
  kind: RepairAdvice["kind"];
  /** The strategist's cross-run note, when the advice carried one. */
  memo?: string;
  textDigest: string | null;
};

type RepairAdviceOutcome = "failure-unchanged" | "failure-moved" | "resolved";

/**
 * The artifact evidence for one completed preparation repair round.
 * Producers must supply both the agent candidate and post-resolution
 * lifecycle so the ledger cannot hide fields dropped between those seams.
 */
export type RepairRoundSource = {
  advice: RepairRoundAdviceRecord | null;
  budget: RepairBudgetSnapshot;
  candidateFingerprint: string;
  candidateManifest: RepairLifecycle;
  failureReport: {
    failingFeatureIds?: readonly string[];
    failureClassification?: string;
    logsSummary: string;
    stage: string;
  };
  outcomeOfAdvice: RepairAdviceOutcome | null;
  resolvedManifest: RepairLifecycle;
  round: number;
  workspaceDiff: { changedPaths: readonly string[] };
};

type RepairRoundLedgerEntry = {
  advice: RepairRoundAdviceRecord | null;
  budget: RepairBudgetSnapshot;
  candidateFingerprint: string;
  candidateLifecycle: Required<RepairLifecycle>;
  causalHeadline: string;
  failingFeatureIds: string[];
  failureClassification: string;
  outcomeOfAdvice: RepairAdviceOutcome | null;
  resolvedLifecycle: Required<RepairLifecycle>;
  round: number;
  stage: string;
  workspaceDiffSummary: {
    changedPathCount: number;
    topLevelDirs: string[];
  };
};

export type RepairRoundLedger = {
  rounds: RepairRoundLedgerEntry[];
};

/**
 * Joins completed preparation repair artifacts into the strategist's
 * comparative, deterministic input. The builder never infers or rewrites a
 * validation verdict; it only reduces artifact fields for bounded review.
 */
export function createRepairRoundLedger(
  rounds: readonly RepairRoundSource[],
): RepairRoundLedger {
  return {
    rounds: rounds.map((round) => ({
      advice: round.advice,
      budget: { ...round.budget },
      candidateFingerprint: round.candidateFingerprint,
      candidateLifecycle: readLifecycle(round.candidateManifest),
      causalHeadline: readCausalHeadline(round.failureReport.logsSummary),
      failingFeatureIds: [...(round.failureReport.failingFeatureIds ?? [])],
      failureClassification:
        round.failureReport.failureClassification ?? "unknown",
      outcomeOfAdvice: round.outcomeOfAdvice,
      resolvedLifecycle: readLifecycle(round.resolvedManifest),
      round: round.round,
      stage: round.failureReport.stage,
      workspaceDiffSummary: {
        changedPathCount: round.workspaceDiff.changedPaths.length,
        topLevelDirs: readTopLevelDirs(round.workspaceDiff.changedPaths),
      },
    })),
  };
}

function readLifecycle(lifecycle: RepairLifecycle): Required<RepairLifecycle> {
  return {
    appDir: lifecycle.appDir,
    buildCommandUsed: lifecycle.buildCommandUsed ?? null,
    installCommandUsed: lifecycle.installCommandUsed,
    ports: [...lifecycle.ports],
    startCommandUsed: lifecycle.startCommandUsed,
  };
}

function readCausalHeadline(logsSummary: string): string {
  return (
    logsSummary
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "No causal headline recorded."
  );
}

function readTopLevelDirs(paths: readonly string[]): string[] {
  const directories = paths.map((path) => {
    const relativePath = toRepoRelativePath(path);
    const segments = relativePath
      .split("/")
      .filter((segment) => segment !== "");
    return segments.length <= 1 ? "." : (segments[0] ?? ".");
  });
  return [...new Set(directories)].sort();
}
