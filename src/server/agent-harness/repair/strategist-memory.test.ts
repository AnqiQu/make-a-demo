import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileStrategistMemoryStore,
  readFailedStage,
  readFailureMovedLifecycle,
  readLastLifecycleFragment,
  readLastPassingLifecycle,
  readLastPassingProofAnchors,
  readStrategistAdviceNotes,
  toStrategistMemoryLifecycle,
  toStrategistMemoryProofAnchors,
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

describe("readLastLifecycleFragment", () => {
  it("reads the newest recorded fragment and skips fragment-less entries", () => {
    // N179 (twenty): the round-4 nx graph build moved the failure every
    // wave and was lost every wave; the fragment is how a run that never
    // passed still leaves its closest form behind.
    const older = {
      appDir: ".",
      installCommandUsed: "yarn install",
      startCommandUsed: "yarn run start",
    };
    const newer = {
      appDir: ".",
      buildCommandUsed: "yarn nx run-many -t build",
      installCommandUsed: "yarn install --immutable",
      startCommandUsed: "yarn run start",
    };

    expect(
      readLastLifecycleFragment([
        { ...entry("run-1", "failed"), lifecycleFragment: older },
        { ...entry("run-2", "failed"), lifecycleFragment: newer },
        entry("run-3", "failed"),
      ]),
    ).toEqual(newer);
    expect(
      readLastLifecycleFragment([entry("run-1", "failed")]),
    ).toBeUndefined();
    expect(readLastLifecycleFragment([])).toBeUndefined();
  });

  it("ignores passing lifecycles and malformed fragments when reading fragments", () => {
    const lifecycle = {
      appDir: ".",
      installCommandUsed: "bun install",
      startCommandUsed: "bun run dev",
    };
    expect(
      readLastLifecycleFragment([{ ...entry("run-1", "passed"), lifecycle }]),
    ).toBeUndefined();
    expect(
      readLastLifecycleFragment([
        {
          ...entry("run-2", "failed"),
          lifecycleFragment: { appDir: 7 } as never,
        },
      ]),
    ).toBeUndefined();
  });
});

describe("readFailureMovedLifecycle", () => {
  it("reads the run's mirrored failure-moved lifecycle artifact", async () => {
    const directory = await memoryDirectory();
    const artifactPath = join(directory, "failure-moved-lifecycle.json");
    const lifecycle = {
      appDir: ".",
      buildCommandUsed: "yarn nx run-many -t build",
      installCommandUsed: "yarn install --immutable",
      startCommandUsed: "yarn run start",
    };
    await writeFile(artifactPath, JSON.stringify({ lifecycle, round: 4 }));

    await expect(readFailureMovedLifecycle(artifactPath)).resolves.toEqual(
      lifecycle,
    );
  });

  it("returns undefined for a missing or malformed artifact", async () => {
    const directory = await memoryDirectory();
    await expect(
      readFailureMovedLifecycle(join(directory, "absent.json")),
    ).resolves.toBeUndefined();

    const tornPath = join(directory, "torn.json");
    await writeFile(tornPath, '{"lifecycle": {"appDir"');
    await expect(readFailureMovedLifecycle(tornPath)).resolves.toBeUndefined();

    const malformedPath = join(directory, "malformed.json");
    await writeFile(
      malformedPath,
      JSON.stringify({ lifecycle: { appDir: 7 }, round: 1 }),
    );
    await expect(
      readFailureMovedLifecycle(malformedPath),
    ).resolves.toBeUndefined();
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

describe("toStrategistMemoryProofAnchors", () => {
  it("reduces grounded verdicts to declared proof targets and grounding routes", () => {
    // N184 (midday): the last pass grounded "INV-1042" on /invoices, then
    // preparation re-rolled the fixtures and no memory surface knew what
    // "right" content looked like.
    const anchors = toStrategistMemoryProofAnchors({
      actionCatalogActions: [
        { id: "open-transactions", route: "/transactions/list" },
      ],
      featureInventory: [
        {
          entryPaths: ["/invoices"],
          expectedProof: { kind: "visible-text", text: "INV-1042" },
          id: "invoicing",
        },
        {
          entryPaths: ["/transactions"],
          expectedProof: {
            kind: "element-appears",
            name: "Transactions table",
          },
          id: "transactions",
        },
        // No declared proof: nothing to anchor.
        { entryPaths: ["/"], id: "dashboard" },
        {
          entryPaths: ["/settings"],
          expectedProof: { kind: "visible-text", text: "Team members" },
          id: "settings",
        },
      ],
      featureVerdicts: [
        {
          evidence: ["declared-proof-invoicing"],
          featureId: "invoicing",
          verdict: "grounded",
        },
        {
          evidence: ["open-transactions"],
          featureId: "transactions",
          verdict: "grounded",
        },
        { featureId: "dashboard", verdict: "grounded" },
        { featureId: "settings", verdict: "failed" },
      ],
    });

    expect(anchors).toEqual([
      {
        featureId: "invoicing",
        proof: 'visible text "INV-1042"',
        route: "/invoices",
      },
      {
        featureId: "transactions",
        proof: 'element "Transactions table" appears',
        route: "/transactions/list",
      },
    ]);
  });

  it("renders each declared proof kind in the maker's vocabulary", () => {
    const anchors = toStrategistMemoryProofAnchors({
      featureInventory: [
        {
          entryPaths: ["/state"],
          expectedProof: {
            contains: "dark",
            key: "theme",
            kind: "app-state",
            source: "localStorage",
          },
          id: "app-state-feature",
        },
        {
          entryPaths: ["/canvas"],
          expectedProof: { kind: "canvas-delta", locator: "#canvas" },
          id: "canvas-feature",
        },
        {
          entryPaths: ["/status"],
          expectedProof: {
            from: "draft",
            kind: "state-transition",
            locator: "[data-status]",
            to: "sent",
          },
          id: "transition-feature",
        },
      ],
      featureVerdicts: [
        { featureId: "app-state-feature", verdict: "grounded" },
        { featureId: "canvas-feature", verdict: "grounded" },
        { featureId: "transition-feature", verdict: "grounded" },
      ],
    });

    expect(anchors.map((anchor) => anchor.proof)).toEqual([
      'app state localStorage.theme contains "dark"',
      'canvas at "#canvas" changes',
      '"[data-status]" transitions from "draft" to "sent"',
    ]);
  });

  it("skips a grounded feature that supplies no route and a verdict without a feature", () => {
    const anchors = toStrategistMemoryProofAnchors({
      featureInventory: [
        {
          entryPaths: [],
          expectedProof: { kind: "visible-text", text: "Routeless" },
          id: "routeless",
        },
      ],
      featureVerdicts: [
        { featureId: "routeless", verdict: "grounded" },
        { featureId: "unknown-feature", verdict: "grounded" },
      ],
    });

    expect(anchors).toEqual([]);
  });
});

describe("readLastPassingProofAnchors", () => {
  it("reads the newest passing run's anchors and skips anchor-less passes", () => {
    const anchors = [
      {
        featureId: "invoicing",
        proof: 'visible text "INV-1042"',
        route: "/invoices",
      },
    ];
    expect(
      readLastPassingProofAnchors([
        { ...entry("run-oldest", "passed"), proofAnchors: anchors },
        { ...entry("run-middle", "passed") },
        {
          ...entry("run-newest", "failed"),
          proofAnchors: [
            { featureId: "never", proof: "never", route: "/never" },
          ],
        },
      ]),
    ).toEqual(anchors);
  });

  it("ignores malformed persisted anchors instead of surfacing them", () => {
    expect(
      readLastPassingProofAnchors([
        {
          ...entry("run-malformed", "passed"),
          proofAnchors: [{ featureId: 7, proof: "x", route: "/x" } as never],
        },
      ]),
    ).toBeUndefined();
    expect(readLastPassingProofAnchors([])).toBeUndefined();
  });
});
