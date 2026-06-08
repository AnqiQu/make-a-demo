import { describe, expect, it } from "vitest";

import { ResendFinalVideoEmailNotifier } from "./resend-final-video-email-notifier";

describe("ResendFinalVideoEmailNotifier", () => {
  it("sends the maker a final video email through Resend with an idempotency key", async () => {
    const requests: Array<{
      body: unknown;
      headers: Record<string, string>;
      url: string;
    }> = [];
    const notifier = new ResendFinalVideoEmailNotifier({
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

    await notifier.sendFinalVideoReadyEmail({
      demoRequestId: "demo-request-123",
      title: "Generated Demo",
      to: "maker@example.com",
      videoUrl:
        "https://makeademo.example/api/demo-requests/demo-request-123/video",
    });

    expect(requests).toEqual([
      {
        body: {
          from: "MakeADemo <demo@makeademo.example>",
          html: expect.stringContaining(
            "https://makeademo.example/api/demo-requests/demo-request-123/video",
          ),
          subject: "Your MakeADemo video is ready",
          text: expect.stringContaining(
            "https://makeademo.example/api/demo-requests/demo-request-123/video",
          ),
          to: ["maker@example.com"],
        },
        headers: {
          Authorization: "Bearer re_test",
          "Content-Type": "application/json",
          "Idempotency-Key": "final-video-ready-demo-request-123",
        },
        url: "https://api.resend.com/emails",
      },
    ]);
  });

  it("surfaces Resend API failures", async () => {
    const notifier = new ResendFinalVideoEmailNotifier({
      apiKey: "re_test",
      fetch: async () =>
        new Response(JSON.stringify({ message: "Domain not verified" }), {
          status: 422,
        }),
      fromEmail: "MakeADemo <demo@makeademo.example>",
    });

    await expect(
      notifier.sendFinalVideoReadyEmail({
        demoRequestId: "demo-request-123",
        title: "Generated Demo",
        to: "maker@example.com",
        videoUrl:
          "https://makeademo.example/api/demo-requests/demo-request-123/video",
      }),
    ).rejects.toThrow("Resend failed to send final video email");
  });
});
