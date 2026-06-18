import { describe, expect, it } from "vitest";

import { NeonDemoRequestFinalVideoStore } from "./neon-demo-request-final-video-store";

describe("NeonDemoRequestFinalVideoStore", () => {
  it("saves the generated script package on the Demo Request", async () => {
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

    await store.saveGeneratedScript({
      demoRequestId: "demo-request-123",
      script: {
        assumptions: [],
        demoPlan: {
          featureOrder: ["article feed"],
          narrative: "Show the article feed.",
          risks: [],
        },
        estimatedDurationSeconds: 5,
        exploration: {
          assumptions: [],
          productSurfaces: ["article feed"],
          summary: "Prepared app.",
        },
        format: "16:9",
        scriptId: "script_test",
        sections: [
          {
            id: "section_test",
            scenes: [
              {
                description: "Show article feed.",
                durationSeconds: 5,
                events: ["Open app"],
                id: "scene_article_feed",
                playwrightSceneId: "scene_article_feed",
                playwrightScript: "await page.goto(baseUrl);",
                type: "playwright-recording",
              },
            ],
            title: "Article Feed",
          },
        ],
        title: "Demo",
        validation: {
          blockedNetworkAttempts: [],
          browserUrl: "https://preview.example.test/",
          logs: ["validated"],
          status: "succeeded",
          warnings: [],
        },
        version: 1,
      },
    });

    expect(updates).toEqual([
      {
        script: expect.objectContaining({
          scriptId: "script_test",
          title: "Demo",
        }),
      },
    ]);
  });

  it("links the generated final video to the Demo Request without writing queue status", async () => {
    const updates: unknown[] = [];
    const db = {
      select() {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  innerJoin() {
                    return {
                      where() {
                        return {
                          limit: async () => [
                            {
                              email: "maker@example.com",
                            },
                          ],
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
      update() {
        return {
          set(values: unknown) {
            updates.push(values);
            return {
              where() {
                return {
                  returning: async () => [
                    {
                      finalVideoEmailSentAt: null,
                      id: "demo-request-123",
                    },
                  ],
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
        demoRequestId: "demo-request-123",
        generatedDemoUrl: "r2://owlet/demo-videos/demo-request-123/video.mp4",
      }),
    ).resolves.toEqual({
      finalVideoEmailSentAt: null,
      makerEmail: "maker@example.com",
    });

    expect(updates).toEqual([
      {
        generatedDemoUrl: "r2://owlet/demo-videos/demo-request-123/video.mp4",
      },
    ]);
  });

  it("marks the final video ready email as sent", async () => {
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

    await store.markFinalVideoEmailSent({
      demoRequestId: "demo-request-123",
      sentAt: "2026-06-08T02:00:00.000Z",
    });

    expect(updates).toEqual([
      {
        finalVideoEmailSentAt: new Date("2026-06-08T02:00:00.000Z"),
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
              innerJoin() {
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

  it("maps queued Projects to processing status", async () => {
    const db = {
      select() {
        return {
          from() {
            return {
              innerJoin() {
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
