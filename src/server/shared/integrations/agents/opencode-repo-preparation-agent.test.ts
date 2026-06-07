import { describe, expect, it } from "vitest";

import { OpenCodeRepoPreparationAgent } from "./opencode-repo-preparation-agent";

describe("OpenCodeRepoPreparationAgent", () => {
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
    expect(JSON.stringify(chatBodies[0])).toContain("validation dashboard");
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
});
