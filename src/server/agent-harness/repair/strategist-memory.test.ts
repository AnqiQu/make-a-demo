import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileStrategistMemoryStore,
  readFailedStage,
  readStrategistAdviceNotes,
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
