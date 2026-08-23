import type {
  MatrixRunEmailNotifier,
  MatrixRunReportEmailInput,
} from "./matrix-run-email-notifier.interface";

type ResendFetch = (input: string, init: RequestInit) => Promise<Response>;

export type ResendMatrixRunEmailNotifierOptions = {
  apiKey: string;
  fetch?: ResendFetch;
  fromEmail: string;
};

export class ResendMatrixRunEmailNotifier implements MatrixRunEmailNotifier {
  private readonly apiKey: string;
  private readonly fetch: ResendFetch;
  private readonly fromEmail: string;

  constructor(options: ResendMatrixRunEmailNotifierOptions) {
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.fromEmail = options.fromEmail;
  }

  async sendMatrixRunReportEmail(
    input: MatrixRunReportEmailInput,
  ): Promise<void> {
    const response = await this.fetch("https://api.resend.com/emails", {
      body: JSON.stringify({
        from: this.fromEmail,
        html: renderMatrixRunReportHtml(input),
        subject: renderMatrixRunReportSubject(input),
        text: renderMatrixRunReportText(input),
        to: [input.to],
      }),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `matrix-run-${input.batchStamp}`,
      },
      method: "POST",
    });

    if (!response.ok) {
      throw new Error("Resend failed to send matrix run email");
    }
  }
}

function renderMatrixRunReportSubject(input: MatrixRunReportEmailInput) {
  return `MakeADemo matrix run finished: ${input.passed} passed, ${input.failed} failed, ${input.skipped} skipped`;
}

function renderMatrixRunReportText(input: MatrixRunReportEmailInput) {
  return `${renderMatrixRunReportSubject(input)}

${input.reportMarkdown}`;
}

function renderMatrixRunReportHtml(input: MatrixRunReportEmailInput) {
  return `<p>${escapeHtml(renderMatrixRunReportSubject(input))}</p>
<pre>${escapeHtml(input.reportMarkdown)}</pre>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
