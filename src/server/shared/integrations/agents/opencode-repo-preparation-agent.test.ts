import { describe, expect, it } from "vitest";

import {
  OpenCodeRepoPreparationAgent,
  resolveOpenCodeSessionDirectory,
} from "./opencode-repo-preparation-agent";

describe("OpenCodeRepoPreparationAgent", () => {
  it("uses the container workspace path for Dockerized OpenCode sessions", () => {
    expect(
      resolveOpenCodeSessionDirectory({
        directory: "/tmp/makeademo-workspaces/workspace_123",
        isolateWithDocker: true,
      }),
    ).toBe("/workspace");
  });

  it("uses the host workspace path for local OpenCode sessions", () => {
    expect(
      resolveOpenCodeSessionDirectory({
        directory: "/tmp/makeademo-workspaces/workspace_123",
        isolateWithDocker: false,
      }),
    ).toBe("/tmp/makeademo-workspaces/workspace_123");
  });

  it("asks OpenCode to prepare the repo and returns the manifest from the assistant JSON", async () => {
    const chatBodies: unknown[] = [];
    const agent = new OpenCodeRepoPreparationAgent({
      client: {
        session: {
          async chat(_id, body) {
            chatBodies.push(body);
            return { id: "assistant_message" };
          },
          async create() {
            return { id: "session_123" };
          },
          async messages() {
            return [
              {
                info: { id: "assistant_message", role: "assistant" },
                parts: [
                  {
                    text: JSON.stringify({
                      manifest: {
                        assumptions: [],
                        createdFiles: ["src/demo.ts"],
                        demoCommand: "npm run demo:makeademo",
                        diffArtifactId: "artifact_diff",
                        existingDemoEvidence: [],
                        mockedServices: ["api.example.com"],
                        modifiedFiles: ["package.json"],
                        repoUrl: "https://github.com/example/app",
                        risks: [],
                        scriptGenerationContext: [
                          "Dashboard shows validation status",
                        ],
                        setupSummary: "Created a deterministic local demo.",
                        status: "created-new-demo",
                        url: "http://localhost:3000",
                        workspaceId: "workspace_123",
                      },
                      status: "succeeded",
                    }),
                    type: "text",
                  },
                ],
              },
            ];
          },
        },
      },
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [
        {
          normalizedText: "Demo the validation dashboard.",
          sourceArtifactId: "artifact_doc",
          sourceFileName: "brief.md",
        },
      ],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation dashboard"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      manifest: {
        demoCommand: "npm run demo:makeademo",
        mockedServices: ["api.example.com"],
      },
      status: "succeeded",
    });
    expect(JSON.stringify(chatBodies[0])).toContain("runtime network lockdown");
    expect(JSON.stringify(chatBodies[0])).toContain("demoCommand");
    expect(JSON.stringify(chatBodies[0])).toContain("scriptGenerationContext");
    expect(JSON.stringify(chatBodies[0])).toContain("/workspace");
    expect(JSON.stringify(chatBodies[0])).toContain("/tmp/opencode/repo");
    expect(JSON.stringify(chatBodies[0])).toContain("validation dashboard");
    expect(chatBodies[0]).toMatchObject({
      tools: {
        bash: true,
        edit: true,
        question: false,
        read: true,
        search: true,
        webfetch: true,
      },
    });
  });

  it("returns a structured preparation failure when OpenCode does not return JSON", async () => {
    const agent = new OpenCodeRepoPreparationAgent({
      client: {
        session: {
          async chat() {
            return { id: "assistant_message" };
          },
          async create() {
            return { id: "session_123" };
          },
          async messages() {
            return [
              {
                info: { id: "assistant_message", role: "assistant" },
                parts: [{ text: "I changed some files.", type: "text" }],
              },
            ];
          },
        },
      },
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation dashboard"] },
      workspaceId: "workspace_123",
    });

    expect(result).toEqual({
      assumptions: [],
      blockers: [
        "OpenCode returned a response that was not valid preparation JSON.",
      ],
      status: "failed",
      suggestedChanges: [
        "Retry repo preparation and require JSON-only output.",
      ],
    });
  });

  it("returns a structured preparation failure when OpenCode cannot run the prompt", async () => {
    const agent = new OpenCodeRepoPreparationAgent({
      client: {
        session: {
          async chat() {
            throw new Error("model openai/gpt-5.5 is unavailable");
          },
          async create() {
            return { id: "session_123" };
          },
          async messages() {
            throw new Error("messages should not be read after prompt failure");
          },
        },
      },
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation dashboard"] },
      workspaceId: "workspace_123",
    });

    expect(result).toEqual({
      assumptions: [],
      blockers: ["OpenCode prompt failed: model openai/gpt-5.5 is unavailable"],
      status: "failed",
      suggestedChanges: [
        "Retry repo preparation after fixing the OpenCode provider, model, or server configuration.",
      ],
    });
  });

  it("reports OpenCode response errors when the SDK prompt response has no data", async () => {
    const agent = new OpenCodeRepoPreparationAgent({
      client: {
        session: {
          async chat() {
            throw new Error(
              "OpenCode did not return a prompt response: 400 Bad Request: tools.search is not supported",
            );
          },
          async create() {
            return { id: "session_123" };
          },
          async messages() {
            throw new Error("messages should not be read after prompt failure");
          },
        },
      },
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    const result = await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation dashboard"] },
      workspaceId: "workspace_123",
    });

    expect(result).toMatchObject({
      blockers: [
        "OpenCode prompt failed: OpenCode did not return a prompt response: 400 Bad Request: tools.search is not supported",
      ],
      status: "failed",
    });
  });

  it("closes the OpenCode server after repo preparation finishes", async () => {
    let closeCount = 0;
    const agent = new OpenCodeRepoPreparationAgent({
      client: {
        close() {
          closeCount += 1;
        },
        session: {
          async chat() {
            return { id: "assistant_message" };
          },
          async create() {
            return { id: "session_123" };
          },
          async messages() {
            return [
              {
                info: { id: "assistant_message", role: "assistant" },
                parts: [
                  {
                    text: JSON.stringify({
                      manifest: {
                        assumptions: [],
                        createdFiles: [],
                        demoCommand: "npm run demo:makeademo",
                        diffArtifactId: "artifact_diff",
                        existingDemoEvidence: [],
                        mockedServices: [],
                        modifiedFiles: [],
                        repoUrl: "https://github.com/example/app",
                        risks: [],
                        scriptGenerationContext: [],
                        setupSummary: "Prepared demo runtime.",
                        status: "created-new-demo",
                        url: "http://localhost:3000",
                        workspaceId: "workspace_123",
                      },
                      status: "succeeded",
                    }),
                    type: "text",
                  },
                ],
              },
            ];
          },
        },
      },
      modelID: "gpt-5.5",
      providerID: "openai",
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation dashboard"] },
      workspaceId: "workspace_123",
    });

    expect(closeCount).toBe(1);
  });

  it("streams compact OpenCode progress lines while preparing the repo", async () => {
    const progressLines: string[] = [];
    const agent = new OpenCodeRepoPreparationAgent({
      client: {
        events: async function* () {
          yield {
            properties: {
              part: {
                delta: "Checking package scripts",
                sessionID: "session_123",
                type: "text",
              },
            },
            type: "message.part.updated",
          };
          yield {
            properties: {
              part: {
                sessionID: "session_123",
                state: { status: "running", title: "bun install" },
                tool: "bash",
                type: "tool",
              },
            },
            type: "message.part.updated",
          };
          yield {
            properties: { file: "package.json" },
            type: "file.edited",
          };
        },
        session: {
          async chat() {
            await new Promise((resolve) => setTimeout(resolve, 0));
            return { id: "assistant_message" };
          },
          async create() {
            return { id: "session_123" };
          },
          async messages() {
            return [
              {
                info: { id: "assistant_message", role: "assistant" },
                parts: [
                  {
                    text: JSON.stringify({
                      manifest: {
                        assumptions: [],
                        createdFiles: [],
                        demoCommand: "npm run demo:makeademo",
                        diffArtifactId: "artifact_diff",
                        existingDemoEvidence: [],
                        mockedServices: [],
                        modifiedFiles: [],
                        repoUrl: "https://github.com/example/app",
                        risks: [],
                        scriptGenerationContext: [],
                        setupSummary: "Prepared demo runtime.",
                        status: "created-new-demo",
                        url: "http://localhost:3000",
                        workspaceId: "workspace_123",
                      },
                      status: "succeeded",
                    }),
                    type: "text",
                  },
                ],
              },
            ];
          },
        },
      },
      modelID: "gpt-5.5",
      onProgress: (line) => progressLines.push(line),
      providerID: "openai",
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation dashboard"] },
      workspaceId: "workspace_123",
    });

    expect(progressLines).toEqual([
      "[opencode] Checking package scripts",
      "[opencode] bash: bun install",
      "[opencode] edited package.json",
    ]);
  });

  it("forwards events from the SDK-backed OpenCode client", async () => {
    const progressLines: string[] = [];
    const agent = new OpenCodeRepoPreparationAgent({
      client: {
        events: async function* () {
          yield {
            properties: {
              part: {
                delta: "Inspecting demo scripts",
                sessionID: "session_123",
                type: "text",
              },
            },
            type: "message.part.updated",
          };
        },
        session: {
          async chat() {
            return { id: "assistant_message" };
          },
          async create() {
            return { id: "session_123" };
          },
          async messages() {
            return [
              {
                info: { id: "assistant_message", role: "assistant" },
                parts: [
                  {
                    text: JSON.stringify({
                      manifest: {
                        assumptions: [],
                        createdFiles: [],
                        demoCommand: "npm run demo",
                        diffArtifactId: "artifact_diff",
                        existingDemoEvidence: [],
                        mockedServices: [],
                        modifiedFiles: [],
                        repoUrl: "https://github.com/example/app",
                        risks: [],
                        scriptGenerationContext: [],
                        setupSummary: "Prepared demo runtime.",
                        status: "created-new-demo",
                        url: "http://localhost:3000",
                        workspaceId: "workspace_123",
                      },
                      status: "succeeded",
                    }),
                    type: "text",
                  },
                ],
              },
            ];
          },
        },
      },
      modelID: "gpt-5.5",
      onProgress: (line) => progressLines.push(line),
      providerID: "openai",
    });

    await agent.prepare({
      normalizedSupportingDocuments: [],
      repoUrl: "https://github.com/example/app",
      structuredDemoIntent: { keyProductFeatures: ["validation dashboard"] },
      workspaceId: "workspace_123",
    });

    expect(progressLines).toEqual(["[opencode] Inspecting demo scripts"]);
  });
});
