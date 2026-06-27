import { describe, expect, it } from "vitest";

import { parseStage1CliArgs } from "./stage1-cli-options";

describe("parseStage1CliArgs", () => {
  it("parses repo, features, and docs while setting execution options internally", () => {
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
      ]),
    ).toMatchObject({
      docs: ["./brief.md"],
      features: ["validation dashboard", "script package"],
      modelID: "gpt-5.5",
      providerID: "openai",
      repoUrl: "https://github.com/example/app",
    });
  });

  it("rejects CLI overrides for internally managed execution options", () => {
    const baseArgs = [
      "--repo",
      "https://github.com/example/app",
      "--feature",
      "validation dashboard",
    ];

    expect(() =>
      parseStage1CliArgs([...baseArgs, "--provider", "openai"]),
    ).toThrowError("Unknown option: --provider");
    expect(() =>
      parseStage1CliArgs([...baseArgs, "--model", "gpt-5.5"]),
    ).toThrowError("Unknown option: --model");
    expect(() =>
      parseStage1CliArgs([...baseArgs, "--workspace-id", "workspace_test"]),
    ).toThrowError("Unknown option: --workspace-id");
    expect(() =>
      parseStage1CliArgs([
        ...baseArgs,
        "--daytona-snapshot",
        "makeademo-opencode",
      ]),
    ).toThrowError("Unknown option: --daytona-snapshot");
  });

  it("uses the configured Daytona snapshot default when no flag is passed", () => {
    expect(
      parseStage1CliArgs(
        [
          "--repo",
          "https://github.com/example/app",
          "--feature",
          "validation dashboard",
        ],
        { daytonaSnapshot: "makeademo-opencode" },
      ).daytonaSnapshot,
    ).toBe("makeademo-opencode");
  });

  it("requires a repo and at least one feature", () => {
    expect(() => parseStage1CliArgs([])).toThrowError("--repo is required");

    expect(() =>
      parseStage1CliArgs(["--repo", "https://github.com/example/app"]),
    ).toThrowError("at least one --feature is required");
  });

  it("generates a workspace ID internally", () => {
    expect(
      parseStage1CliArgs([
        "--repo",
        "https://github.com/example/app",
        "--feature",
        "validation dashboard",
      ]).workspaceId,
    ).toMatch(/^workspace-example-app-\d+$/);
  });

  it("rejects the legacy local workspace root option", () => {
    expect(() =>
      parseStage1CliArgs([
        "--repo",
        "https://github.com/example/app",
        "--feature",
        "validation dashboard",
        "--workspace-root",
        "/tmp/makeademo-workspaces",
      ]),
    ).toThrowError("Unknown option: --workspace-root");
  });

  it("rejects the legacy Repo Preparation runtime selector", () => {
    expect(() =>
      parseStage1CliArgs([
        "--repo",
        "https://github.com/example/app",
        "--feature",
        "validation dashboard",
        "--repo-preparation-runtime",
        "docker",
      ]),
    ).toThrowError("Unknown option: --repo-preparation-runtime");
  });
});
