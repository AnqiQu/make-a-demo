import { describe, expect, it } from "vitest";

import { parseStage1CliArgs } from "./stage1-cli-options";

describe("parseStage1CliArgs", () => {
  it("parses repo, features, docs, and model options", () => {
    expect(
      parseStage1CliArgs([
        "--repo",
        "https://github.com/example/app",
        "--feature",
        "validation dashboard",
        "--feature",
        "script package",
        "--doc",
        "./brief.md",
        "--provider",
        "openai",
        "--model",
        "gpt-5.5",
        "--workspace-id",
        "workspace_test",
      ]),
    ).toEqual({
      docs: ["./brief.md"],
      features: ["validation dashboard", "script package"],
      modelID: "gpt-5.5",
      providerID: "openai",
      repoUrl: "https://github.com/example/app",
      workspaceId: "workspace_test",
      workspaceRoot: "/tmp/makeademo-workspaces",
    });
  });

  it("requires a repo and at least one feature", () => {
    expect(() => parseStage1CliArgs([])).toThrowError("--repo is required");

    expect(() =>
      parseStage1CliArgs(["--repo", "https://github.com/example/app"]),
    ).toThrowError("at least one --feature is required");
  });
});
