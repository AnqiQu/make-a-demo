import { describe, expect, it } from "vitest";

import { NeonProjectDemoGenerationQueueStore } from "./neon-project-demo-generation-queue-store";

describe("NeonProjectDemoGenerationQueueStore", () => {
  it("claims the next queued Project and maps intake context into a demo generation job", async () => {
    const updates: unknown[] = [];
    const db = {
      select() {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  where() {
                    return {
                      orderBy() {
                        return {
                          limit: async () => [
                            {
                              context: {
                                structuredContext: {
                                  importantFeatures:
                                    "script generation, video generation",
                                  productSummary: "Creates demo videos.",
                                  requestedDurationSeconds: 60,
                                  targetUsers: "Founders",
                                },
                                transcript: [],
                              },
                              demoRequestId: "demo-request-1",
                              projectId: "project-1",
                              repoUrl: "https://github.com/example/app",
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
                  returning: async () => [{ id: "project-1" }],
                };
              },
            };
          },
        };
      },
    };
    const store = new NeonProjectDemoGenerationQueueStore(db);

    await expect(store.claimNextQueuedProject()).resolves.toEqual({
      demoBrief: {
        audience: "Founders",
        keyProductFeatures: ["script generation", "video generation"],
      },
      demoRequestId: "demo-request-1",
      normalizedSupportingDocuments: [],
      projectId: "project-1",
      repoUrl: "https://github.com/example/app",
      workspaceId: "project-1",
    });
    expect(updates).toEqual([{ status: "processing" }]);
  });

  it("marks Project queue status completed or failed without touching Demo Request status", async () => {
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
                  returning: async () => [{ id: "project-1" }],
                };
              },
            };
          },
        };
      },
    };
    const store = new NeonProjectDemoGenerationQueueStore(db);

    await store.markProjectCompleted({
      generatedDemoUrl: "r2://owlet/demo-videos/demo-request-1/final.mp4",
      projectId: "project-1",
    });
    await store.markProjectFailed({
      error: "renderer failed",
      projectId: "project-2",
    });

    expect(updates).toEqual([{ status: "completed" }, { status: "failed" }]);
  });
});
