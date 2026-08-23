export type MatrixRunReportEmailInput = {
  batchStamp: string;
  failed: number;
  passed: number;
  reportMarkdown: string;
  skipped: number;
  to: string;
};

/**
 * Notifies the operator that a pipeline matrix batch has finished.
 *
 * Implementations must include the per-entry pass/fail/skip summary so the
 * message is actionable without opening the run directory, and must use the
 * batch stamp as an idempotency key so a transient failure after a successful
 * send is retried without delivering a duplicate report.
 */
export interface MatrixRunEmailNotifier {
  sendMatrixRunReportEmail(input: MatrixRunReportEmailInput): Promise<void>;
}
