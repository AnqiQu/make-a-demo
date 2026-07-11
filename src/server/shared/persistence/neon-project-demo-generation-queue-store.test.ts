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
                              },
                              demoRequestId: "demo-request-1",
                              githubInstallationId: "installation-123",
                              projectId: "project-1",
                              repoUrl: "https://github.com/example/app",
                              supportingFiles: [
                                JSON.stringify({
                                  fileName: "product.md",
                                  mimeType: "text/markdown",
                                  r2Key: "uploads/draft-1/product.md",
                                  r2Url:
                                    "r2://owlet/uploads/draft-1/product.md",
                                  sizeBytes: 128,
                                }),
                              ],
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
    const store = new NeonProjectDemoGenerationQueueStore(
      db,
      {
        async loadSupportingDocuments(input) {
          expect(input).toEqual([
            {
              fileName: "product.md",
              mimeType: "text/markdown",
              r2Key: "uploads/draft-1/product.md",
              r2Url: "r2://owlet/uploads/draft-1/product.md",
              sizeBytes: 128,
            },
          ]);

          return [
            {
              normalizedText: "Product context from R2.",
              sourceArtifactId: "r2://owlet/uploads/draft-1/product.md",
              sourceFileName: "product.md",
            },
          ];
        },
      },
      {
        createLeaseToken: () => "lease-1",
        leaseDurationMs: 60_000,
        now: () => new Date("2026-07-11T10:00:00.000Z"),
      },
    );

    await expect(store.claimNextQueuedProject()).resolves.toEqual({
      demoBrief: {
        audience: "Founders",
        demoLengthSeconds: 60,
        keyProductFeatures: ["script generation", "video generation"],
        productSummary: "Creates demo videos.",
      },
      demoRequestId: "demo-request-1",
      githubInstallationId: "installation-123",
      normalizedSupportingDocuments: [
        {
          normalizedText: "Product context from R2.",
          sourceArtifactId: "r2://owlet/uploads/draft-1/product.md",
          sourceFileName: "product.md",
        },
      ],
      leaseToken: "lease-1",
      projectId: "project-1",
      repoUrl: "https://github.com/example/app",
      workspaceId: "project-1",
    });
    expect(updates).toEqual([
      {
        attemptCount: 1,
        lastError: null,
        processingLeaseExpiresAt: new Date("2026-07-11T10:01:00.000Z"),
        processingLeaseToken: "lease-1",
        processingStartedAt: new Date("2026-07-11T10:00:00.000Z"),
        status: "processing",
      },
    ]);
  });

  it("marks a claimed Project failed when Supporting Documents cannot be normalized", async () => {
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
                                  importantFeatures: "script generation",
                                  productSummary: "Creates demo videos.",
                                  targetUsers: "Founders",
                                },
                              },
                              demoRequestId: "demo-request-1",
                              projectId: "project-1",
                              repoUrl: "https://github.com/example/app",
                              supportingFiles: [
                                JSON.stringify({
                                  fileName: "deck.pdf",
                                  mimeType: "application/pdf",
                                  r2Key: "uploads/draft-1/deck.pdf",
                                  r2Url: "r2://owlet/uploads/draft-1/deck.pdf",
                                  sizeBytes: 128,
                                }),
                              ],
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
    const store = new NeonProjectDemoGenerationQueueStore(
      db,
      {
        async loadSupportingDocuments() {
          throw new Error("PDF normalization unavailable");
        },
      },
      {
        createLeaseToken: () => "lease-docs",
        now: () => new Date("2026-07-11T10:00:00.000Z"),
      },
    );

    await expect(store.claimNextQueuedProject()).resolves.toBeUndefined();
    expect(updates).toEqual([
      {
        attemptCount: 1,
        lastError: null,
        processingLeaseExpiresAt: new Date("2026-07-11T10:05:00.000Z"),
        processingLeaseToken: "lease-docs",
        processingStartedAt: new Date("2026-07-11T10:00:00.000Z"),
        status: "processing",
      },
      {
        lastError: "PDF normalization unavailable",
        processingLeaseExpiresAt: null,
        processingLeaseToken: null,
        status: "failed",
      },
    ]);
  });

  it("reclaims an expired processing lease with a new ownership token", async () => {
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
                              attemptCount: 2,
                              context: {
                                structuredContext: {
                                  importantFeatures: "dashboard",
                                },
                              },
                              demoRequestId: "demo-request-1",
                              processingLeaseExpiresAt: new Date(
                                "2026-07-11T09:59:00.000Z",
                              ),
                              processingLeaseToken: "expired-lease",
                              projectId: "project-1",
                              repoUrl: "https://github.com/example/app",
                              status: "processing",
                              supportingFiles: [],
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
    const store = new NeonProjectDemoGenerationQueueStore(db, undefined, {
      createLeaseToken: () => "replacement-lease",
      now: () => new Date("2026-07-11T10:00:00.000Z"),
    });

    await expect(store.claimNextQueuedProject()).resolves.toMatchObject({
      leaseToken: "replacement-lease",
      projectId: "project-1",
    });
    expect(updates).toEqual([
      expect.objectContaining({
        attemptCount: 3,
        processingLeaseToken: "replacement-lease",
        status: "processing",
      }),
    ]);
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
      leaseToken: "lease-1",
      projectId: "project-1",
    });
    await store.markProjectFailed({
      error: "renderer failed",
      leaseToken: "lease-2",
      projectId: "project-2",
    });

    expect(updates).toEqual([
      {
        lastError: null,
        processingLeaseExpiresAt: null,
        processingLeaseToken: null,
        status: "completed",
      },
      {
        lastError: "renderer failed",
        processingLeaseExpiresAt: null,
        processingLeaseToken: null,
        status: "failed",
      },
    ]);
  });

  it("refuses completion after processing lease ownership is lost", async () => {
    const db = {
      select() {
        throw new Error("select should not be called");
      },
      update() {
        return {
          set() {
            return {
              where() {
                return { returning: async () => [] };
              },
            };
          },
        };
      },
    };
    const store = new NeonProjectDemoGenerationQueueStore(db);

    await expect(
      store.markProjectCompleted({
        generatedDemoUrl: "r2://demo/final.mp4",
        leaseToken: "stale-lease",
        projectId: "project-1",
      }),
    ).rejects.toThrow("processing lease is no longer owned");
  });
});
