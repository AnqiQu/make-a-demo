import { describe, expect, it } from "vitest";

import { R2FinalVideoStorage } from "./r2-final-video-storage";

describe("R2FinalVideoStorage", () => {
  it("stores final demo videos under a Demo Request-scoped R2 key", async () => {
    const storage = new R2FinalVideoStorage({
      bucket: "owlet",
      putObject: async (input) => {
        expect(input.bucket).toBe("owlet");
        expect(input.contentType).toBe("video/mp4");
        expect(input.key).toBe(
          "demo-videos/demo-request-123/composite-001/final-video.mp4",
        );
        expect(new TextDecoder().decode(input.body)).toBe("rendered mp4");
      },
      presignGet: async () => {
        throw new Error("presignGet should not be called");
      },
      presignPut: async () => {
        throw new Error("presignPut should not be called");
      },
    });

    const result = await storage.storeFinalVideo({
      body: new TextEncoder().encode("rendered mp4"),
      contentType: "video/mp4",
      demoRequestId: "demo-request-123",
      fileName: "final-video.mp4",
      runId: "composite-001",
      scriptId: "script-123",
    });

    expect(result).toEqual({
      key: "demo-videos/demo-request-123/composite-001/final-video.mp4",
      r2Url:
        "r2://owlet/demo-videos/demo-request-123/composite-001/final-video.mp4",
    });
  });
});
