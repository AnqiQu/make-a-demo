import { describe, expect, it } from "vitest";

import { ResendMatrixRunEmailNotifier } from "./resend-matrix-run-email-notifier";

const reportMarkdown = `| Entry | Status | Duration | Detail |
|---|---|---|---|
| vite-spa | passed | 61s | run/final-video.mp4 |
| midday | failed | 42s | exploration failed |
`;

describe("ResendMatrixRunEmailNotifier", () => {
  it("emails the finished matrix report through Resend with a batch idempotency key", async () => {
    const requests: Array<{
      body: Record<string, unknown>;
      headers: Record<string, string>;
      url: string;
    }> = [];
    const notifier = new ResendMatrixRunEmailNotifier({
      apiKey: "re_test",
      fetch: async (url, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)),
          headers: init?.headers as Record<string, string>,
          url: String(url),
        });
        return new Response(JSON.stringify({ id: "email-123" }), {
          status: 200,
        });
      },
      fromEmail: "MakeADemo <demo@makeademo.example>",
    });

    await notifier.sendMatrixRunReportEmail({
      batchStamp: "2026-08-12T18-00-00-000Z",
      failed: 1,
      passed: 1,
      reportMarkdown,
      skipped: 0,
      to: "operator@example.com",
    });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe("https://api.resend.com/emails");
    expect(request?.headers).toEqual({
      Authorization: "Bearer re_test",
      "Content-Type": "application/json",
      "Idempotency-Key": "matrix-run-2026-08-12T18-00-00-000Z",
    });
    expect(request?.body.from).toBe("MakeADemo <demo@makeademo.example>");
    expect(request?.body.to).toEqual(["operator@example.com"]);
    // The summary counts belong in the subject so the result is visible from
    // the inbox list without opening the mail.
    expect(String(request?.body.subject)).toContain("1 passed");
    expect(String(request?.body.subject)).toContain("1 failed");
    // The full report table rides along verbatim in the plain-text body.
    expect(String(request?.body.text)).toContain(reportMarkdown);
  });

  it("surfaces Resend API failures", async () => {
    const notifier = new ResendMatrixRunEmailNotifier({
      apiKey: "re_test",
      fetch: async () =>
        new Response(JSON.stringify({ message: "Domain not verified" }), {
          status: 422,
        }),
      fromEmail: "MakeADemo <demo@makeademo.example>",
    });

    await expect(
      notifier.sendMatrixRunReportEmail({
        batchStamp: "2026-08-12T18-00-00-000Z",
        failed: 1,
        passed: 1,
        reportMarkdown,
        skipped: 0,
        to: "operator@example.com",
      }),
    ).rejects.toThrow("Resend failed to send matrix run email");
  });
});
