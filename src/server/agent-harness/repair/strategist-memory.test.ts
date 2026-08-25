import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileStrategistMemoryStore,
  readFailedStage,
  readLastPassingLifecycle,
  readStrategistAdviceNotes,
  toStrategistMemoryLifecycle,
} from "./strategist-memory";

async function memoryDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "makeademo-strategist-memory-"));
}

const entry = (runId: string, outcome: "passed" | "failed") => ({
  adviceNotes: [
    {
      kind: "directive",
      memo: "Seed auth through the demo gate.",
      text: "Repair the demo authentication path.",
    },
  ],
  outcome,
  recordedAt: "2026-08-23T00:00:00.000Z",
  runId,
});

describe("createFileStrategistMemoryStore", () => {
  it("persists run entries as an append-only per-repo log and reads them back", async () => {
    const store = createFileStrategistMemoryStore({
      directory: await memoryDirectory(),
    });
    await store.append({
      entry: entry("run-1", "failed"),
      repoUrl: "https://github.com/calcom/cal.com",
    });
    await store.append({
      entry: entry("run-2", "passed"),
      repoUrl: "https://github.com/calcom/cal.com",
    });

    await expect(
      store.readRecent({
        limit: 5,
        repoUrl: "https://github.com/calcom/cal.com",
      }),
    ).resolves.toEqual([entry("run-1", "failed"), entry("run-2", "passed")]);
  });

  it("keys the log by normalized repo identity, not URL spelling", async () => {
    const store = createFileStrategistMemoryStore({
      directory: await memoryDirectory(),
    });
    await store.append({
      entry: entry("run-1", "failed"),
      repoUrl: "https://github.com/Calcom/Cal.com.git",
    });
    await expect(
      store.readRecent({
        limit: 5,
        repoUrl: "https://github.com/calcom/cal.com",
      }),
    ).resolves.toEqual([entry("run-1", "failed")]);
  });

  it("returns only the most recent entries and tolerates a missing or corrupt log", async () => {
    const directory = await memoryDirectory();
    const store = createFileStrategistMemoryStore({ directory });
    await expect(
      store.readRecent({ limit: 3, repoUrl: "https://github.com/acme/none" }),
    ).resolves.toEqual([]);

    for (const runId of ["run-1", "run-2", "run-3", "run-4"]) {
      await store.append({
        entry: entry(runId, "failed"),
        repoUrl: "https://github.com/acme/app",
      });
    }
    // A torn write must cost one line, never the log.
    const logPath = join(directory, "github-com-acme-app.jsonl");
    await writeFile(logPath, `${await readFile(logPath, "utf8")}{"torn`);
    await expect(
      store.readRecent({ limit: 2, repoUrl: "https://github.com/acme/app" }),
    ).resolves.toEqual([entry("run-3", "failed"), entry("run-4", "failed")]);
  });
});

describe("readLastPassingLifecycle", () => {
  it("round-trips a passing run's resolved lifecycle through the store", async () => {
    // N178 (midday, wave-21): the digest carried only the outcome line, so
    // five repair rounds stayed blind to the fact that the last pass
    // installed unfiltered — a fact one JSONL line away.
    const store = createFileStrategistMemoryStore({
      directory: await memoryDirectory(),
    });
    const lifecycle = {
      appDir: "apps/dashboard",
      installCommandUsed: "bun install --frozen-lockfile",
      startCommandUsed: "bun run dev",
    };
    await store.append({
      entry: { ...entry("run-1", "passed"), lifecycle },
      repoUrl: "https://github.com/midday-ai/midday",
    });

    const read = await store.readRecent({
      limit: 3,
      repoUrl: "https://github.com/midday-ai/midday",
    });
    expect(readLastPassingLifecycle(read)).toEqual(lifecycle);
  });

  it("reads the newest passing lifecycle and skips failed or lifecycle-less entries", () => {
    const older = {
      appDir: ".",
      installCommandUsed: "bun install",
      startCommandUsed: "bun run dev",
    };
    const newer = {
      appDir: ".",
      buildCommandUsed: "bun run build",
      installCommandUsed: "bun install --frozen-lockfile",
      startCommandUsed: "bun run preview",
    };

    expect(
      readLastPassingLifecycle([
        { ...entry("run-1", "passed"), lifecycle: older },
        { ...entry("run-2", "passed"), lifecycle: newer },
        // A digest recorded before the lifecycle field existed.
        entry("run-3", "passed"),
        { ...entry("run-4", "failed"), lifecycle: older },
      ]),
    ).toEqual(newer);
    expect(
      readLastPassingLifecycle([entry("run-1", "failed")]),
    ).toBeUndefined();
    expect(readLastPassingLifecycle([])).toBeUndefined();
  });

  it("ignores a malformed persisted lifecycle instead of surfacing it", () => {
    // The JSONL reader is deliberately tolerant, so a hand-edited or torn
    // lifecycle can reach this seam; evidence must present nothing rather
    // than a reconstructed form.
    expect(
      readLastPassingLifecycle([
        {
          ...entry("run-1", "passed"),
          lifecycle: { appDir: 7 } as never,
        },
      ]),
    ).toBeUndefined();
  });

  it("reduces a preparation manifest to the digest's lifecycle fields", () => {
    expect(
      toStrategistMemoryLifecycle({
        appDir: "apps/dashboard",
        buildCommandUsed: "pnpm run build",
        dataStrategy: [
          {
            detail: "postgres backs calendars",
            migrationCommand: "pnpm db:migrate",
            rung: "provisioned-service",
            seedCommand: "pnpm db:seed",
            service: "postgres",
          },
        ],
        installCommandUsed: "pnpm install --frozen-lockfile",
        startCommandUsed: "pnpm run dev",
      }),
    ).toEqual({
      appDir: "apps/dashboard",
      buildCommandUsed: "pnpm run build",
      dataStrategy: [
        {
          migrationCommand: "pnpm db:migrate",
          rung: "provisioned-service",
          seedCommand: "pnpm db:seed",
          service: "postgres",
        },
      ],
      installCommandUsed: "pnpm install --frozen-lockfile",
      startCommandUsed: "pnpm run dev",
    });

    const minimal = toStrategistMemoryLifecycle({
      appDir: ".",
      installCommandUsed: "bun install",
      startCommandUsed: "bun run dev",
    });
    expect(minimal).toEqual({
      appDir: ".",
      installCommandUsed: "bun install",
      startCommandUsed: "bun run dev",
    });
    expect(minimal).not.toHaveProperty("buildCommandUsed");
    expect(minimal).not.toHaveProperty("dataStrategy");
  });
});

describe("readStrategistAdviceNotes", () => {
  it("collects kinds, prose, and memos from the run's passed consultation artifacts", async () => {
    const artifactsDirectory = await memoryDirectory();
    const attempts = join(artifactsDirectory, "repair-strategy");
    await mkdir(attempts, { recursive: true });
    await writeFile(
      join(attempts, "attempt-1.json"),
      JSON.stringify({
        advice: {
          hint: "Build the workspace graph first.",
          kind: "escalate-hint",
          memo: "twenty-ui/dist must exist before the app builds.",
        },
        attempt: 1,
        status: "passed",
      }),
    );
    await writeFile(
      join(attempts, "attempt-2.json"),
      JSON.stringify({ attempt: 2, error: "timeout", status: "failed" }),
    );
    await writeFile(
      join(attempts, "attempt-3.json"),
      JSON.stringify({
        advice: { kind: "stop", reason: "Wedged target." },
        attempt: 3,
        status: "passed",
      }),
    );

    await expect(
      readStrategistAdviceNotes(artifactsDirectory),
    ).resolves.toEqual([
      {
        kind: "escalate-hint",
        memo: "twenty-ui/dist must exist before the app builds.",
        text: "Build the workspace graph first.",
      },
      { kind: "stop", text: "Wedged target." },
    ]);
  });

  it("returns no notes when the run never consulted", async () => {
    await expect(
      readStrategistAdviceNotes(await memoryDirectory()),
    ).resolves.toEqual([]);
  });
});

describe("readFailedStage", () => {
  it("names the failed stage from the run manifest and stays silent otherwise", async () => {
    const directory = await memoryDirectory();
    const manifestPath = join(directory, "pipeline-run-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        stageStatuses: {
          "preparation-preflight": "failed",
          "repo-preparation": "passed",
        },
      }),
    );
    await expect(readFailedStage(manifestPath)).resolves.toBe(
      "preparation-preflight",
    );
    await expect(
      readFailedStage(join(directory, "missing.json")),
    ).resolves.toBeUndefined();
  });
});
