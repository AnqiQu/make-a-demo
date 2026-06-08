import { describe, expect, it } from "vitest";

import { NeonDemoRequestFinalVideoStore } from "./neon-demo-request-final-video-store";

describe("NeonDemoRequestFinalVideoStore", () => {
  it("links the generated final video to the Demo Request", async () => {
    const updates: unknown[] = [];
    const db = {
      select() {
        throw new Error("select should not be called");
      },
      update() {
        return {
          set(values: unknown) {
            updates.push(values);
            return {
              where() {
                return {
                  returning: async () => [{ id: "demo-request-123" }],
                };
              },
            };
          },
        };
      },
    };
    const store = new NeonDemoRequestFinalVideoStore(db);

    await store.linkFinalVideo({
      demoRequestId: "demo-request-123",
      generatedDemoUrl: "r2://owlet/demo-videos/demo-request-123/video.mp4",
    });

    expect(updates).toEqual([
      {
        generatedDemoUrl: "r2://owlet/demo-videos/demo-request-123/video.mp4",
        status: "completed",
      },
    ]);
  });

  it("rejects missing Demo Requests instead of creating a link", async () => {
    const db = {
      select() {
        throw new Error("select should not be called");
      },
      update() {
        return {
          set() {
            return {
              where() {
                return {
                  returning: async () => [],
                };
              },
            };
          },
        };
      },
    };
    const store = new NeonDemoRequestFinalVideoStore(db);

    await expect(
      store.linkFinalVideo({
        demoRequestId: "missing-request",
        generatedDemoUrl: "r2://owlet/demo-videos/missing-request/video.mp4",
      }),
    ).rejects.toThrow("Failed to link final video to Demo Request");
  });

  it("reads completed Demo Request status with the generated final video URL", async () => {
    const db = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit: async () => [
                    {
                      generatedDemoUrl:
                        "r2://owlet/demo-videos/demo-request-123/video.mp4",
                      status: "completed",
                    },
                  ],
                };
              },
            };
          },
        };
      },
      update() {
        throw new Error("update should not be called");
      },
    };
    const store = new NeonDemoRequestFinalVideoStore(db);

    await expect(
      store.readDemoRequestStatus("demo-request-123"),
    ).resolves.toEqual({
      generatedDemoUrl: "r2://owlet/demo-videos/demo-request-123/video.mp4",
      status: "completed",
    });
  });

  it("maps queued Demo Requests to processing status", async () => {
    const db = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit: async () => [
                    {
                      generatedDemoUrl: null,
                      status: "queued",
                    },
                  ],
                };
              },
            };
          },
        };
      },
      update() {
        throw new Error("update should not be called");
      },
    };
    const store = new NeonDemoRequestFinalVideoStore(db);

    await expect(
      store.readDemoRequestStatus("demo-request-123"),
    ).resolves.toEqual({
      status: "processing",
    });
  });
});
