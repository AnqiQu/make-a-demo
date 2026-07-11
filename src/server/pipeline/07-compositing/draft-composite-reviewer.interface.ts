type DraftCompositeReviewInput = {
  attempt: number;
  outputVideoPath: string;
  renderPlanPath: string;
  scriptId: string;
};

type DraftCompositeReviewResult = {
  findings: string[];
  status: "accepted" | "rejected";
  warnings: string[];
};

export class DraftCompositeReviewRejectedError extends Error {
  readonly findings: readonly string[];
  readonly reviewArtifactPath: string;

  constructor(input: { findings: string[]; reviewArtifactPath: string }) {
    super(
      `Draft Composite review rejected publication: ${input.findings.join("; ") || "no finding supplied"}`,
    );
    this.name = "DraftCompositeReviewRejectedError";
    this.findings = input.findings;
    this.reviewArtifactPath = input.reviewArtifactPath;
  }
}

/**
 * Reviews a rendered Draft Composite before it can be published as final.
 * Implementations must return accepted only when the complete rendered file is
 * suitable for publication; failures and uncertainty must fail closed.
 */
export interface DraftCompositeReviewer {
  reviewDraftComposite(
    input: DraftCompositeReviewInput,
  ): Promise<DraftCompositeReviewResult>;
}
