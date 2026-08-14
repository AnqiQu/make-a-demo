import { describe, expect, it } from "vitest";
import {
  batteryPowerWarning,
  matrixRepoEnvVar,
  notifyMatrixRunComplete,
  renderMatrixReport,
  resolveMatrixEntries,
  resolveMatrixNotification,
  runPipelineMatrix,
} from "../scripts/run-pipeline-matrix";
import type { DefaultDemoPipelineResult } from "../src/server/agent-harness/default/default-demo-pipeline";
import type { MatrixRunReportEmailInput } from "../src/server/shared/integrations/email/matrix-run-email-notifier.interface";

const enabledNotificationEnv = {
  RESEND_API_KEY: "re_test",
  RESEND_FROM_EMAIL: "MakeADemo <demo@makeademo.example>",
  TEXTME: "true",
  TEXTME_EMAIL: "operator@example.com",
};

function recordingNotifier(behaviour?: { throwOnSend?: boolean }) {
  const sent: MatrixRunReportEmailInput[] = [];
  return {
    sendMatrixRunReportEmail: async (input: MatrixRunReportEmailInput) => {
      sent.push(input);
      if (behaviour?.throwOnSend) {
        throw new Error("Resend failed to send matrix run email");
      }
    },
    sent,
  };
}

const oneOfEachResult = [
  { detail: "run/final-video.mp4", name: "vite-spa", status: "passed" },
  { detail: "exploration failed", name: "midday", status: "failed" },
  { detail: "no repo URL", name: "pnpm-monorepo", status: "skipped" },
] as const;

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

  it("hands every entry the same batch bulk-transfer limiter", async () => {
    // Each entry's multi-GB clone and archive upload share one uplink; the
    // batch must hand every pipeline the same limiter so those transfers
    // serialize instead of starving each other (calcom and ghostfolio died
    // mid-clone behind twenty's 294MB upload, 2026-08-13T23-23).
    const limiters: unknown[] = [];
    await runPipelineMatrix(
      resolveMatrixEntries(
        [
          { name: "alpha", repoUrl: "https://github.com/example/alpha" },
          { name: "bravo", repoUrl: "https://github.com/example/bravo" },
        ],
        {},
      ),
      {
        log: () => {},
        runPipeline: async (_input, _runId, batch) => {
          limiters.push(batch.bulkTransferLimiter);
          await batch.bulkTransferLimiter.run(async () => {});
          return passingPipelineResult();
        },
      },
    );

    expect(limiters).toHaveLength(2);
    expect(limiters[0]).toBeDefined();
    expect(limiters[0]).toBe(limiters[1]);
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

describe("resolveMatrixNotification", () => {
  it("stays disabled unless TEXTME is explicitly on", () => {
    expect(resolveMatrixNotification({}).status).toBe("disabled");
    expect(resolveMatrixNotification({ TEXTME: "false" }).status).toBe(
      "disabled",
    );
    expect(resolveMatrixNotification({ TEXTME: "0" }).status).toBe("disabled");
  });

  it("resolves the recipient and reused Resend credentials when fully configured", () => {
    const notification = resolveMatrixNotification({
      RESEND_API_KEY: "re_test",
      RESEND_FROM_EMAIL: "MakeADemo <demo@makeademo.example>",
      TEXTME: "true",
      TEXTME_EMAIL: "operator@example.com",
    });

    expect(notification).toEqual({
      apiKey: "re_test",
      fromEmail: "MakeADemo <demo@makeademo.example>",
      status: "enabled",
      to: "operator@example.com",
    });
  });

  it("reports misconfiguration by name instead of throwing when a value is missing", () => {
    const notification = resolveMatrixNotification({
      RESEND_API_KEY: "re_test",
      RESEND_FROM_EMAIL: "MakeADemo <demo@makeademo.example>",
      TEXTME: "1",
    });

    expect(notification.status).toBe("misconfigured");
    if (notification.status !== "misconfigured") {
      throw new Error("expected a misconfigured notification");
    }
    expect(notification.reason).toContain("TEXTME_EMAIL");
  });
});

describe("notifyMatrixRunComplete", () => {
  it("sends nothing when TEXTME is disabled", async () => {
    const notifier = recordingNotifier();
    await notifyMatrixRunComplete({
      batchStamp: "2026-08-12T18-00-00-000Z",
      env: {},
      log: () => {},
      notifier,
      reportMarkdown: "| Entry | Status |\n",
      results: [...oneOfEachResult],
    });

    expect(notifier.sent).toEqual([]);
  });

  it("emails the recipient the report with the per-status counts when enabled", async () => {
    const notifier = recordingNotifier();
    await notifyMatrixRunComplete({
      batchStamp: "2026-08-12T18-00-00-000Z",
      env: enabledNotificationEnv,
      log: () => {},
      notifier,
      reportMarkdown: "| Entry | Status |\n",
      results: [...oneOfEachResult],
    });

    expect(notifier.sent).toEqual([
      {
        batchStamp: "2026-08-12T18-00-00-000Z",
        failed: 1,
        passed: 1,
        reportMarkdown: "| Entry | Status |\n",
        skipped: 1,
        to: "operator@example.com",
      },
    ]);
  });

  it("swallows and logs a notifier failure so the batch result is unaffected", async () => {
    const notifier = recordingNotifier({ throwOnSend: true });
    const logs: string[] = [];
    await expect(
      notifyMatrixRunComplete({
        batchStamp: "2026-08-12T18-00-00-000Z",
        env: enabledNotificationEnv,
        log: (message) => logs.push(message),
        notifier,
        reportMarkdown: "| Entry | Status |\n",
        results: [...oneOfEachResult],
      }),
    ).resolves.toBeUndefined();

    expect(notifier.sent).toHaveLength(1);
    expect(logs.some((line) => line.includes("run notification failed"))).toBe(
      true,
    );
  });

  it("logs which value is missing and sends nothing when misconfigured", async () => {
    const notifier = recordingNotifier();
    const logs: string[] = [];
    await notifyMatrixRunComplete({
      batchStamp: "2026-08-12T18-00-00-000Z",
      env: { ...enabledNotificationEnv, TEXTME_EMAIL: undefined },
      log: (message) => logs.push(message),
      notifier,
      reportMarkdown: "| Entry | Status |\n",
      results: [...oneOfEachResult],
    });

    expect(notifier.sent).toEqual([]);
    expect(logs.some((line) => line.includes("TEXTME_EMAIL"))).toBe(true);
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
