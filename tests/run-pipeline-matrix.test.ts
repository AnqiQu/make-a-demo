import { describe, expect, it } from "vitest";
import {
  batteryPowerWarning,
  matrixRepoEnvVar,
  renderMatrixReport,
  resolveMatrixEntries,
  runPipelineMatrix,
} from "../scripts/run-pipeline-matrix";

const runnableEntry = {
  name: "vite-spa",
  fixtureDir: "tests/fixtures/repos/vite-spa",
  repoUrl: "https://github.com/example/fixture-vite-spa",
};

describe("resolveMatrixEntries", () => {
  it("prefers the per-entry environment override to the configured repo URL", () => {
    const [entry] = resolveMatrixEntries([runnableEntry], {
      [matrixRepoEnvVar("vite-spa")]:
        "https://github.com/example/override-repo",
    });

    expect(entry).toMatchObject({
      name: "vite-spa",
      status: "runnable",
    });
    if (entry?.status !== "runnable") {
      throw new Error("expected a runnable entry");
    }
    expect(entry.input.repoUrl).toBe(
      "https://github.com/example/override-repo",
    );
  });

  it("skips an entry without a repo URL and explains how to provide one", () => {
    const [entry] = resolveMatrixEntries(
      [
        {
          name: "pnpm-monorepo",
          fixtureDir: "tests/fixtures/repos/pnpm-monorepo",
        },
      ],
      {},
    );

    expect(entry).toMatchObject({ name: "pnpm-monorepo", status: "skipped" });
    if (entry?.status !== "skipped") {
      throw new Error("expected a skipped entry");
    }
    expect(entry.reason).toContain("tests/fixtures/repos/pnpm-monorepo");
    expect(entry.reason).toContain(matrixRepoEnvVar("pnpm-monorepo"));
  });

  it("fills pipeline input defaults while preserving configured values", () => {
    const [entry] = resolveMatrixEntries(
      [
        {
          name: "midday",
          repoUrl: "https://github.com/midday-ai/midday",
          demoLengthSeconds: 45,
          preferredAppDir: "apps/dashboard",
        },
      ],
      {},
    );

    if (entry?.status !== "runnable") {
      throw new Error("expected a runnable entry");
    }
    expect(entry.input).toMatchObject({
      demoLengthSeconds: 45,
      importantFeatures: [],
      preferredAppDir: "apps/dashboard",
      repoUrl: "https://github.com/midday-ai/midday",
    });
  });
});

describe("runPipelineMatrix", () => {
  it("runs entries sequentially and keeps going when one fails", async () => {
    const calls: string[] = [];
    const results = await runPipelineMatrix(
      resolveMatrixEntries(
        [
          { name: "passes", repoUrl: "https://github.com/example/passes" },
          { name: "fails", repoUrl: "https://github.com/example/fails" },
          { name: "unpublished" },
        ],
        {},
      ),
      {
        log: () => {},
        runPipeline: async (input) => {
          calls.push(input.repoUrl);
          if (input.repoUrl.endsWith("fails")) {
            throw new Error("exploration failed\nstack line");
          }
          return {
            artifactDirectory: "run/artifacts",
            captureManifestPath: "run/capture.json",
            compositeManifestPath: "run/composite.json",
            finalVideoPath: "run/final-video.mp4",
            logPath: "run/pipeline-log.jsonl",
            pipelineManifestPath: "run/manifest.json",
            runDirectory: "run",
            scriptPath: "run/demo-script.json",
          };
        },
      },
    );

    expect(calls).toEqual([
      "https://github.com/example/passes",
      "https://github.com/example/fails",
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "passed",
      "failed",
      "skipped",
    ]);
    expect(results[0]).toMatchObject({
      detail: "run/final-video.mp4",
      runDirectory: "run",
    });
    expect(results[1]?.detail).toBe("exploration failed");
  });
});

describe("renderMatrixReport", () => {
  it("renders one row per entry with status and detail", () => {
    const report = renderMatrixReport([
      {
        detail: "run/final-video.mp4",
        durationMs: 61_000,
        name: "vite-spa",
        runDirectory: "run",
        status: "passed",
      },
      { detail: "exploration failed", name: "midday", status: "failed" },
      { detail: "no repo URL", name: "pnpm-monorepo", status: "skipped" },
    ]);

    expect(report).toContain("vite-spa");
    expect(report).toContain("passed");
    expect(report).toContain("run/final-video.mp4");
    expect(report).toContain("failed");
    expect(report).toContain("exploration failed");
    expect(report).toContain("skipped");
  });
});

describe("batteryPowerWarning", () => {
  it("warns that a closed lid kills the run when drawing from battery", () => {
    const warning = batteryPowerWarning(
      "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t47%; discharging present: true\n",
    );

    expect(warning).toContain("battery");
    expect(warning).toContain("lid");
  });

  it("stays quiet on AC power or unreadable power state", () => {
    expect(
      batteryPowerWarning("Now drawing from 'AC Power'\n"),
    ).toBeUndefined();
    expect(batteryPowerWarning("")).toBeUndefined();
  });
});
