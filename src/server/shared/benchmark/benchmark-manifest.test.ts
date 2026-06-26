import { describe, expect, it } from "vitest";

import {
  buildBenchmarkPipelineArgs,
  readBenchmarkManifest,
} from "./benchmark-manifest";

describe("readBenchmarkManifest", () => {
  it("reads benchmark defaults and repo entries with repo-specific overrides", () => {
    const manifest = readBenchmarkManifest({
      defaults: {
        mode: "stage1",
        model: "gpt-5.5",
        provider: "openai",
        repetitions: 2,
      },
      repos: [
        {
          categories: ["realworld", "frontend"],
          expectedLevel: "L2",
          features: ["Show the article feed"],
          id: "conduit",
          mode: "full",
          repoUrl: "https://github.com/TonyMckes/conduit-realworld-example-app",
        },
      ],
      version: 1,
    });

    expect(manifest.repos[0]).toMatchObject({
      effectiveMode: "full",
      effectiveModel: "gpt-5.5",
      effectiveProvider: "openai",
      effectiveRepetitions: 2,
      id: "conduit",
    });
  });

  it("rejects duplicate repo ids because results use ids as stable keys", () => {
    expect(() =>
      readBenchmarkManifest({
        repos: [
          {
            categories: [],
            expectedLevel: "L1",
            features: ["Show the app"],
            id: "same",
            repoUrl: "https://github.com/example/one",
          },
          {
            categories: [],
            expectedLevel: "L1",
            features: ["Show the app"],
            id: "same",
            repoUrl: "https://github.com/example/two",
          },
        ],
        version: 1,
      }),
    ).toThrow("Duplicate benchmark repo id: same");
  });
});

describe("buildBenchmarkPipelineArgs", () => {
  it("builds full-pipeline CLI args from a repo benchmark entry", () => {
    const manifest = readBenchmarkManifest({
      defaults: { model: "gpt-5.5", provider: "openai" },
      repos: [
        {
          categories: ["fullstack"],
          daytonaSnapshot: "snapshot-id",
          docs: ["docs/setup.md"],
          expectedLevel: "L5",
          features: ["Show scheduling"],
          id: "calendar",
          mode: "full",
          repoUrl: "https://github.com/example/calendar",
          workspaceId: "workspace-calendar",
        },
      ],
      version: 1,
    });
    const repo = manifest.repos.at(0);
    if (repo === undefined) {
      throw new Error("Expected benchmark repo fixture");
    }

    expect(
      buildBenchmarkPipelineArgs({
        outputRoot: ".makeademo-benchmark-runs/run-1",
        repo,
      }),
    ).toEqual([
      "src/server/shared/pipeline-runner/full-pipeline-cli.mts",
      "--output-root",
      ".makeademo-benchmark-runs/run-1",
      "--repo",
      "https://github.com/example/calendar",
      "--feature",
      "Show scheduling",
      "--doc",
      "docs/setup.md",
    ]);
  });
});
