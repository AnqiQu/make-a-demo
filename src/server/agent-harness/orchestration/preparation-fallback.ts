import { readStderrErrorSignal } from "../app-explorer/stderr-error-signal";
import type { FeatureVerdict, ValidationReport } from "../schemas/artifacts";

const PREPARATION_FALLBACK_SCHEMA_VERSION = "2026-08-10";

export type PreparationFallbackArtifact = {
  blockers: Array<{
    failureClassification?: string;
    /** The last exploration's per-feature verdict ledger (N106), when one exists. */
    featureVerdicts?: FeatureVerdict[];
    /** Error-class stderr lines from the failed run, warning noise removed. */
    stderrErrorSignal?: string;
    suggestedRepairHints: string[];
    summary: string;
  }>;
  commitSha?: string;
  failedStage: string;
  prompt: string;
  repoUrl: string;
  runId: string;
  schemaVersion: typeof PREPARATION_FALLBACK_SCHEMA_VERSION;
};

/**
 * Signals that deterministic Repo Preparation was exhausted and gives callers
 * the durable, coding-agent-ready fallback artifact they should return.
 */
export class PreparationFallbackRequiredError extends Error {
  readonly preparationFallback: PreparationFallbackArtifact;

  constructor(
    message: string,
    preparationFallback: PreparationFallbackArtifact,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PreparationFallbackRequiredError";
    this.preparationFallback = preparationFallback;
  }
}

export function createPreparationFallbackArtifact(input: {
  commitSha?: string;
  error: unknown;
  failedStage: string;
  repoUrl: string;
  runId: string;
  validationReports: ValidationReport[];
}): PreparationFallbackArtifact {
  let latestFailedReport: ValidationReport | undefined;
  for (let index = input.validationReports.length - 1; index >= 0; index -= 1) {
    const report = input.validationReports[index];
    if (report?.status === "failed" && report.stage === input.failedStage) {
      latestFailedReport = report;
      break;
    }
  }
  const failedReports =
    latestFailedReport === undefined ? [] : [latestFailedReport];
  const blockers =
    failedReports.length === 0
      ? [
          {
            suggestedRepairHints: [],
            summary: readErrorMessage(input.error),
          },
        ]
      : failedReports.map((report) => {
          const stderrErrorSignal = readStderrErrorSignal(
            report.stderrExcerpts.join("\n"),
          );
          return {
            ...(report.failureClassification === undefined
              ? {}
              : { failureClassification: report.failureClassification }),
            ...(report.featureVerdicts === undefined ||
            report.featureVerdicts.length === 0
              ? {}
              : { featureVerdicts: report.featureVerdicts }),
            ...(stderrErrorSignal === undefined ? {} : { stderrErrorSignal }),
            suggestedRepairHints: report.suggestedRepairHints,
            summary: report.logsSummary,
          };
        });
  const revision = input.commitSha ?? "the submitted revision";
  const blockerText = blockers
    .map((blocker, index) => `${index + 1}. ${blocker.summary}`)
    .join("\n");
  // The failed run already paid for this evidence: the ledger names each
  // feature's exact blocker, the hints name the repairs the gate wants, and
  // the stderr signal names the server-side fault. A fallback prompt that
  // rendered only logsSummary would restart the outside coding agent from
  // less knowledge than the run it replaces (N106).
  const evidenceSections = blockers.flatMap((blocker) => [
    ...(blocker.featureVerdicts === undefined
      ? []
      : [
          [
            "Per-feature browser verdicts from the failed run:",
            ...blocker.featureVerdicts.map((verdict) =>
              verdict.verdict === "grounded"
                ? `- ${verdict.featureId}: grounded (${verdict.groundedBy})${verdict.detail === undefined ? "" : ` — ${verdict.detail}`}`
                : `- ${verdict.featureId}: failed (${verdict.failedBecause})${verdict.detail === undefined ? "" : ` — ${verdict.detail}`}`,
            ),
          ].join("\n"),
        ]),
    ...(blocker.suggestedRepairHints.length === 0
      ? []
      : [
          [
            "Apply these repair hints from the failed run:",
            ...blocker.suggestedRepairHints.map((hint) => `- ${hint}`),
          ].join("\n"),
        ]),
    ...(blocker.stderrErrorSignal === undefined
      ? []
      : [
          [
            "Decisive app stderr lines observed while routes rendered:",
            blocker.stderrErrorSignal,
          ].join("\n"),
        ]),
  ]);

  return {
    blockers,
    ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
    failedStage: input.failedStage,
    prompt: [
      `Prepare ${input.repoUrl} at ${revision} for a deterministic, local-only MakeADemo run.`,
      "Resolve these observed blockers:",
      blockerText,
      ...evidenceSections,
      "Keep production behavior intact. Add only the local fixtures, mocks, commands, and documented assumptions needed for a repeatable browser demo with runtime network disabled.",
      "Return the exact install, build, start, local URL, fixture, and reset instructions, plus the files changed.",
    ].join("\n\n"),
    repoUrl: input.repoUrl,
    runId: input.runId,
    schemaVersion: PREPARATION_FALLBACK_SCHEMA_VERSION,
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
