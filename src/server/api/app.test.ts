import { describe, expect, it } from "vitest";

import { createApiApp } from "./app";

describe("Context Gathering API", () => {
  it("presigns Supporting Document uploads", async () => {
    const app = createApiApp({
      github: {
        createInstallUrl: () =>
          "https://github.com/apps/owlet/installations/select_target",
        listRepositories: async () => [],
      },
      store: {
        async createQueuedProject() {
          throw new Error("store should not be called");
        },
      },
      uploads: {
        bucket: "owlet",
        createId: () => "file-1",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignPut: async ({ key }) => `https://uploads.example.test/${key}`,
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/uploads/presign", {
        body: JSON.stringify({
          draftId: "draft-1",
          fileName: "Product Brief.md",
          mimeType: "text/markdown",
          sizeBytes: 120,
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      key: "uploads/draft-1/file-1-product-brief.md",
      method: "PUT",
      r2Url: "r2://owlet/uploads/draft-1/file-1-product-brief.md",
    });
  });

  it("stores Supporting Document uploads through the API so the browser does not PUT to R2", async () => {
    const app = createApiApp({
      github: {
        createInstallUrl: () =>
          "https://github.com/apps/owlet/installations/select_target",
        listRepositories: async () => [],
      },
      store: {
        async createQueuedProject() {
          throw new Error("store should not be called");
        },
      },
      uploads: {
        bucket: "owlet",
        createId: () => "file-1",
        async putObject(input) {
          expect(input.bucket).toBe("owlet");
          expect(input.key).toBe("uploads/draft-1/file-1-product-brief.md");
          expect(input.contentType).toBe("text/markdown");
          expect(new TextDecoder().decode(input.body)).toBe("hello");
        },
        presignPut: async () => {
          throw new Error("presignPut should not be called");
        },
      },
    });
    const body = new FormData();
    body.set("draftId", "draft-1");
    body.set(
      "file",
      new File(["hello"], "Product Brief.md", { type: "text/markdown" }),
    );

    const response = await app.fetch(
      new Request("http://localhost/api/uploads", {
        body,
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      fileName: "Product Brief.md",
      key: "uploads/draft-1/file-1-product-brief.md",
      r2Url: "r2://owlet/uploads/draft-1/file-1-product-brief.md",
    });
  });

  it("submits Context Gathering intake and creates a queued demo request", async () => {
    const app = createApiApp({
      github: {
        createInstallUrl: () =>
          "https://github.com/apps/owlet/installations/select_target",
        listRepositories: async () => [],
      },
      store: {
        async createQueuedProject(input) {
          expect(input.user.email).toBe("anqi@example.com");
          expect(input.project.repoVisibility).toBe("public");
          return {
            demoRequestId: "demo-request-1",
            projectId: "project-1",
            status: "queued",
          };
        },
      },
      uploads: {
        bucket: "owlet",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignPut: async () => "https://uploads.example.test/file",
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/context-gathering/submit", {
        body: JSON.stringify({
          contact: { email: "anqi@example.com", name: "Anqi" },
          contextTranscript: [],
          repoUrl: "https://github.com/example/app",
          repoVisibility: "public",
          structuredContext: {
            importantFeatures: "script generation",
            productSummary: "A demo generator.",
            requestedDurationSeconds: 60,
            targetUsers: "Founders",
          },
          supportingFiles: [],
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      demoRequestId: "demo-request-1",
      projectId: "project-1",
      status: "queued",
    });
  });

  it("returns GitHub App install URLs and installation repositories", async () => {
    const app = createApiApp({
      github: {
        createInstallUrl: ({ state }) =>
          `https://github.com/apps/owlet/installations/select_target?state=${state}`,
        listRepositories: async (installationId) => {
          expect(installationId).toBe("123");
          return [
            {
              fullName: "example/private-app",
              private: true,
              repoUrl: "https://github.com/example/private-app",
            },
          ];
        },
      },
      store: {
        async createQueuedProject() {
          throw new Error("store should not be called");
        },
      },
      uploads: {
        bucket: "owlet",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignPut: async () => "https://uploads.example.test/file",
      },
    });

    const installResponse = await app.fetch(
      new Request("http://localhost/api/github/install-url?state=draft-1"),
    );
    expect(installResponse.status).toBe(200);
    await expect(installResponse.json()).resolves.toEqual({
      installUrl:
        "https://github.com/apps/owlet/installations/select_target?state=draft-1",
    });

    const repositoriesResponse = await app.fetch(
      new Request("http://localhost/api/github/installations/123/repositories"),
    );
    expect(repositoriesResponse.status).toBe(200);
    await expect(repositoriesResponse.json()).resolves.toEqual({
      repositories: [
        {
          fullName: "example/private-app",
          private: true,
          repoUrl: "https://github.com/example/private-app",
        },
      ],
    });
  });
});
