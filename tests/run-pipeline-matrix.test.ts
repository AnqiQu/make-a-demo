import { describe, expect, it } from "vitest";
import {
  batteryPowerWarning,
  matrixRepoEnvVar,
  renderMatrixReport,
  resolveMatrixEntries,
  runPipelineMatrix,
} from "../scripts/run-pipeline-matrix";
import type { DefaultDemoPipelineResult } from "../src/server/agent-harness/default/default-demo-pipeline";

const runnableEntry = {
  name: "vite-spa",
  fixtureDir: "tests/fixtures/repos/vite-spa",
  repoUrl: "https://github.com/example/fixture-vite-spa",
};

function passingPipelineResult(): DefaultDemoPipelineResult {
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
}

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
  it("runs every runnable entry concurrently rather than one at a time", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const results = await runPipelineMatrix(
      resolveMatrixEntries(
        [
          { name: "alpha", repoUrl: "https://github.com/example/alpha" },
          { name: "bravo", repoUrl: "https://github.com/example/bravo" },
          { name: "charlie", repoUrl: "https://github.com/example/charlie" },
          { name: "unpublished" },
        ],
        {},
      ),
      {
        log: () => {},
        runPipeline: async () => {
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return passingPipelineResult();
        },
      },
    );

    expect(peakInFlight).toBe(3);
    expect(results.map((result) => result.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "skipped",
    ]);
  });

  it("staggers runnable launches with bounded jitter when enabled", async () => {
    // Eleven sandboxes created in the same second are their own
    // control-plane herd (2026-08-09): create calls queue behind each
    // other's state changes and the batch synchronizes onto every
    // conflict window. Spreading launches 30-60s apart de-correlates them.
    const sleeps: number[] = [];
    const results = await runPipelineMatrix(
      resolveMatrixEntries(
        [
          { name: "alpha", repoUrl: "https://github.com/example/alpha" },
          { name: "unpublished" },
          { name: "bravo", repoUrl: "https://github.com/example/bravo" },
          { name: "charlie", repoUrl: "https://github.com/example/charlie" },
        ],
        {},
      ),
      {
        launchStagger: {
          random: () => 0.5,
          sleep: async (delayMs) => {
            sleeps.push(delayMs);
          },
        },
        log: () => {},
        runPipeline: async () => passingPipelineResult(),
      },
    );

    // The first runnable entry launches immediately; each later one waits
    // its cumulative offset (random 0.5 centers the 30-60s gap at 45s).
    // Skipped entries consume no stagger slot.
    expect(sleeps).toEqual([45_000, 90_000]);
    expect(results.map((result) => result.status)).toEqual([
      "passed",
      "skipped",
      "passed",
      "passed",
    ]);
  });

  it("keeps report rows in entry order and keeps going when one entry fails", async () => {
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
          if (input.repoUrl.endsWith("fails")) {
            throw new Error("exploration failed\nstack line");
          }
          // Settle the passing entry on a much later microtask so the report
          // cannot be ordered by completion instead of by entry position.
          for (let hop = 0; hop < 10; hop += 1) {
            await Promise.resolve();
          }
          return passingPipelineResult();
        },
      },
    );

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
    expect(results[2]?.status).toBe("skipped");
  });

  it("gives each concurrent run its own run id so their directories do not collide", async () => {
    const runIds: string[] = [];
    await runPipelineMatrix(
      resolveMatrixEntries(
        [
          { name: "vite-spa", repoUrl: "https://github.com/example/a" },
          { name: "midday", repoUrl: "https://github.com/example/b" },
        ],
        {},
      ),
      {
        log: () => {},
        runPipeline: async (_input, runId) => {
          runIds.push(runId);
          return passingPipelineResult();
        },
      },
    );

    expect(new Set(runIds).size).toBe(2);
    expect(runIds.some((id) => id.includes("vite-spa"))).toBe(true);
    expect(runIds.some((id) => id.includes("midday"))).toBe(true);
  });

  it("keeps the first informative line when a failure's payload starts on the next line", async () => {
    const results = await runPipelineMatrix(
      resolveMatrixEntries(
        [{ name: "cyberchef", repoUrl: "https://github.com/example/build" }],
        {},
      ),
      {
        log: () => {},
        runPipeline: async () => {
          throw new Error(
            "preparation-preflight failed: Submitted-code build failed: \n\n> cyberchef@11.3.0 build\n> npx grunt prod\n",
          );
        },
      },
    );

    expect(results[0]?.detail).toBe(
      "preparation-preflight failed: Submitted-code build failed: > cyberchef@11.3.0 build",
    );
  });

  it("carries the trailing makeademo marker line and bounds a runaway first line", async () => {
    // Ghost (2026-08-09): the report row was mid-word compiler-warning
    // garbage while the informative fact — the exit=124 trailer — sat at
    // the end of the message. Diagnosis required the JSONL every time.
    const garbage = "readCoord(pCellData+8, &c); aCoord[2] = c.f; ".repeat(20);
    const results = await runPipelineMatrix(
      resolveMatrixEntries(
        [{ name: "ghost", repoUrl: "https://github.com/example/ghost" }],
        {},
      ),
      {
        log: () => {},
        runPipeline: async () => {
          throw new Error(
            [
              `preparation-preflight failed: Network-closed lifecycle scripts failed after the dependency install: ite3 install: ${garbage}`,
              ".../node_modules/sqlite3 install: gyp info ok",
              "[makeademo:command-end] exit=124",
            ].join("\n"),
          );
        },
      },
    );

    const detail = results[0]?.detail ?? "";
    expect(detail).toContain("Network-closed lifecycle scripts failed");
    expect(detail).toContain("[makeademo:command-end] exit=124");
    expect(detail.length).toBeLessThan(400);
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
