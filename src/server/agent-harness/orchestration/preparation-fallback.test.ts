import { describe, expect, it } from "vitest";
import { readValidationReport } from "../schemas/artifacts";
import { createPreparationFallbackArtifact } from "./preparation-fallback";

const failedExplorationReport = (overrides: Record<string, unknown> = {}) =>
  readValidationReport({
    artifactReferences: [],
    blockedNetworkAttempts: [],
    browserObservations: [],
    consoleErrors: [],
    failureClassification: "requested feature not observable",
    logsSummary:
      "App Exploration found no browser evidence for requested features: allocation chart.",
    networkAttempts: [],
    pageErrors: [],
    retryCount: 0,
    screenshots: [],
    stage: "app-exploration",
    status: "failed",
    stderrExcerpts: [],
    stdoutExcerpts: [],
    suggestedRepairHints: [],
    ...overrides,
  });

describe("createPreparationFallbackArtifact", () => {
  it("carries the verdict ledger, repair hints, and decisive stderr into the fallback prompt", () => {
    // N106: the cross-run fallback previously rendered logsSummary alone, so
    // the outside coding agent restarted from less evidence than the failed
    // run had already gathered.
    const artifact = createPreparationFallbackArtifact({
      error: new Error("retry budget exhausted"),
      failedStage: "app-exploration",
      repoUrl: "https://github.com/example/app",
      runId: "run_042",
      validationReports: [
        failedExplorationReport({
          featureVerdicts: [
            {
              evidence: ["assert-heading-1-1"],
              featureId: "portfolio-overview",
              groundedBy: "assert",
              verdict: "grounded",
            },
            {
              detail:
                'best on-screen match "Portfolio holdings overview" (score 1) was awarded to portfolio-overview',
              failedBecause: "route-shared-with-winners",
              featureId: "allocation-chart",
              verdict: "failed",
            },
          ],
          stderrExcerpts: [
            [
              "warn  - experimental features enabled",
              "⨯ Error [TRPCClientError]: Failed to parse URL",
              "Found 0 errors. Watching for file changes.",
            ].join("\n"),
          ],
          suggestedRepairHints: [
            "Give allocation-chart an entry route no other feature claims.",
          ],
        }),
      ],
    });

    expect(artifact.prompt).toContain("portfolio-overview: grounded (assert)");
    expect(artifact.prompt).toContain(
      "allocation-chart: failed (route-shared-with-winners)",
    );
    expect(artifact.prompt).toContain('"Portfolio holdings overview"');
    expect(artifact.prompt).toContain(
      "Give allocation-chart an entry route no other feature claims.",
    );
    expect(artifact.prompt).toContain("⨯ Error [TRPCClientError]");
    expect(artifact.prompt).not.toContain("Found 0 errors");
    expect(artifact.blockers[0]?.featureVerdicts).toHaveLength(2);
    expect(artifact.blockers[0]?.stderrErrorSignal).toContain(
      "TRPCClientError",
    );
  });

  it("omits ledger and stderr sections when the failed report carries neither", () => {
    const artifact = createPreparationFallbackArtifact({
      error: new Error("retry budget exhausted"),
      failedStage: "app-exploration",
      repoUrl: "https://github.com/example/app",
      runId: "run_043",
      validationReports: [
        failedExplorationReport({
          stderrExcerpts: ["Found 0 errors. Watching for file changes."],
        }),
      ],
    });

    expect(artifact.prompt).not.toContain("browser verdicts");
    expect(artifact.prompt).not.toContain("stderr");
    expect(artifact.blockers[0]?.featureVerdicts).toBeUndefined();
    expect(artifact.blockers[0]?.stderrErrorSignal).toBeUndefined();
  });

  it("falls back to the pipeline error when no failed report matches the stage", () => {
    const artifact = createPreparationFallbackArtifact({
      error: new Error("Repo clone failed."),
      failedStage: "repo-preparation",
      repoUrl: "https://github.com/example/app",
      runId: "run_044",
      validationReports: [],
    });

    expect(artifact.blockers).toEqual([
      { suggestedRepairHints: [], summary: "Repo clone failed." },
    ]);
    expect(artifact.prompt).toContain("Repo clone failed.");
  });
});
