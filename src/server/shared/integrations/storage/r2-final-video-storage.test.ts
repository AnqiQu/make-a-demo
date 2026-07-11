import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { R2FinalVideoStorage } from "./r2-final-video-storage";

describe("R2FinalVideoStorage", () => {
  it("stores final demo videos under a Demo Request-scoped R2 key", async () => {
    const storage = new R2FinalVideoStorage({
      bucket: "owlet",
      putObject: async () => {
        throw new Error("buffered putObject must not be used for final video");
      },
      putStreamObject: async (input) => {
        expect(input.bucket).toBe("owlet");
        expect(input.contentLength).toBe(12);
        expect(input.contentType).toBe("video/mp4");
        expect(input.key).toBe(
          "demo-videos/demo-request-123/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/final-video.mp4",
        );
        const body = input.body as Readable;
        const chunks: Uint8Array[] = [];
        for await (const chunk of body) {
          chunks.push(chunk as Uint8Array);
        }
        expect(Buffer.concat(chunks).toString("utf8")).toBe("rendered mp4");
      },
      presignGet: async () => {
        throw new Error("presignGet should not be called");
      },
      presignPut: async () => {
        throw new Error("presignPut should not be called");
      },
    });

    const result = await storage.storeFinalVideo({
      body: Readable.from([Buffer.from("rendered mp4")]),
      contentLength: 12,
      contentType: "video/mp4",
      demoRequestId: "demo-request-123",
      fileName: "final-video.mp4",
      runId: "composite-001",
      scriptDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      scriptId: "script-123",
    });
    const retriedResult = await storage.storeFinalVideo({
      body: Readable.from([Buffer.from("rendered mp4")]),
      contentLength: 12,
      contentType: "video/mp4",
      demoRequestId: "demo-request-123",
      fileName: "final-video.mp4",
      runId: "composite-retry",
      scriptDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      scriptId: "script-123",
    });

    expect(result).toEqual({
      key: "demo-videos/demo-request-123/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/final-video.mp4",
      r2Url:
        "r2://owlet/demo-videos/demo-request-123/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/final-video.mp4",
    });
    expect(retriedResult).toEqual(result);
  });
});
