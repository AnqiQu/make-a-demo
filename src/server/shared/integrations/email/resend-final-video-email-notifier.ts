import type {
  FinalVideoEmailNotifier,
  FinalVideoReadyEmailInput,
} from "../../../pipeline/final-output/final-video-email-notifier.interface";

type ResendFetch = (input: string, init: RequestInit) => Promise<Response>;

export type ResendFinalVideoEmailNotifierOptions = {
  apiKey: string;
  fetch?: ResendFetch;
  fromEmail: string;
};

export class ResendFinalVideoEmailNotifier implements FinalVideoEmailNotifier {
  private readonly apiKey: string;
  private readonly fetch: ResendFetch;
  private readonly fromEmail: string;

  constructor(options: ResendFinalVideoEmailNotifierOptions) {
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.fromEmail = options.fromEmail;
  }

  async sendFinalVideoReadyEmail(
    input: FinalVideoReadyEmailInput,
  ): Promise<void> {
    const response = await this.fetch("https://api.resend.com/emails", {
      body: JSON.stringify({
        from: this.fromEmail,
        html: renderFinalVideoReadyHtml(input),
        subject: "Your MakeADemo video is ready",
        text: renderFinalVideoReadyText(input),
        to: [input.to],
      }),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `final-video-ready-${input.demoRequestId}`,
      },
      method: "POST",
    });

    if (!response.ok) {
      throw new Error("Resend failed to send final video email");
    }
  }
}

export function createResendFinalVideoEmailNotifierFromEnv() {
  return new ResendFinalVideoEmailNotifier({
    apiKey: readRequiredEnv("RESEND_API_KEY"),
    fromEmail: readRequiredEnv("RESEND_FROM_EMAIL"),
  });
}

function renderFinalVideoReadyText(input: FinalVideoReadyEmailInput) {
  return `Your MakeADemo video is ready.

${input.title}

Watch it here:
${input.videoUrl}
`;
}

function renderFinalVideoReadyHtml(input: FinalVideoReadyEmailInput) {
  const title = escapeHtml(input.title);
  const videoUrl = escapeHtml(input.videoUrl);

  return `<p>Your MakeADemo video is ready.</p>
<p><strong>${title}</strong></p>
<p><a href="${videoUrl}">Watch your demo video</a></p>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}
