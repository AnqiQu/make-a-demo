import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import directusWave13 from "../repair/fixtures/directus-wave-13.json";
import ghostfolioWave13 from "../repair/fixtures/ghostfolio-wave-13.json";
import {
  type RepairRoundSource,
  createRepairRoundLedger,
} from "../repair/repair-round-ledger";
import {
  draftWaveDiagnosisNote,
  resolveRunEntryDirectories,
} from "./wave-diagnosis";

async function runRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "makeademo-wave-diagnosis-"));
}

async function writeRunEntry(
  root: string,
  entryName: string,
  artifacts: Record<string, unknown>,
): Promise<string> {
  const entryDirectory = join(root, entryName);
  const makeADemoDirectory = join(
    entryDirectory,
    "artifacts",
    "workspace",
    ".makeademo",
  );
  await mkdir(makeADemoDirectory, { recursive: true });
  for (const [relativePath, value] of Object.entries(artifacts)) {
    const artifactPath = join(makeADemoDirectory, relativePath);
    await mkdir(join(artifactPath, ".."), { recursive: true });
    await writeFile(
      artifactPath,
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
  }
  return entryDirectory;
}

const failedManifest = (failedStage: string) => ({
  finalStatus: "failed",
  stageStatuses: { [failedStage]: "failed" },
});

// Acceptance evidence: the committed wave-13 ledger extracts
// (docs/audits/2026-08-15-meta-agent-plan.md, phase M3).
describe("draftWaveDiagnosisNote", () => {
  it("identifies the ghostfolio resolver field drop between candidate and resolved lifecycles", async () => {
    const root = await runRoot();
    const entry = await writeRunEntry(root, "matrix-wave-13-ghostfolio", {
      "pipeline-run-manifest.json": failedManifest("preparation-preflight"),
      "repair-round-ledger.json": createRepairRoundLedger(
        ghostfolioWave13.rounds as RepairRoundSource[],
      ),
    });

    const note = await draftWaveDiagnosisNote([entry]);

    expect(note).toContain("matrix-wave-13-ghostfolio");
    expect(note).toContain("buildCommandUsed");
    expect(note).toMatch(/dropped/i);
    expect(note).toMatch(/candidate/i);
    expect(note).toContain("Candidate N-item sketches");
  });

  it("identifies the directus dependency-chain shape across same-classification rounds", async () => {
    const root = await runRoot();
    const entry = await writeRunEntry(root, "matrix-wave-13-directus", {
      "pipeline-run-manifest.json": failedManifest("preparation-preflight"),
      "repair-round-ledger.json": createRepairRoundLedger(
        directusWave13.rounds as RepairRoundSource[],
      ),
    });

    const note = await draftWaveDiagnosisNote([entry]);

    expect(note).toMatch(/dependency.chain/i);
    expect(note).toContain("@directus/extensions");
    expect(note).toContain("@directus/constants");
    expect(note).toContain("unbuilt workspace dependency");
  });

  it("summarizes each entry's outcome, failed stage, and final reason from the run manifest", async () => {
    const root = await runRoot();
    const entry = await writeRunEntry(root, "matrix-wave-17-calcom", {
      "pipeline-run-manifest.json": {
        finalStatus: "failed",
        stageStatuses: {
          "preparation-preflight": "failed",
          "repo-preparation": "passed",
        },
        unsupportedOrFailureReason:
          "Agent harness job refused another repair cycle: 6.1 minutes remain.",
      },
    });

    const note = await draftWaveDiagnosisNote([entry]);

    expect(note).toContain(
      "Outcome: failed (failed stage: preparation-preflight)",
    );
    expect(note).toContain(
      "Final reason: Agent harness job refused another repair cycle: 6.1 minutes remain.",
    );
  });

  it("keeps a multi-line final reason to one note line", async () => {
    const root = await runRoot();
    const entry = await writeRunEntry(root, "matrix-wave-13-directus", {
      "pipeline-run-manifest.json": {
        finalStatus: "failed",
        stageStatuses: { "preparation-preflight": "failed" },
        unsupportedOrFailureReason:
          "preparation-preflight failed: Unbuilt workspace dependency @directus/extensions.\nCommand output:\nsrc/cli/commands/add.ts(8,75): error TS2307\nsrc/cli/commands/build.ts(3,91): error TS2307",
      },
    });

    const note = await draftWaveDiagnosisNote([entry]);

    expect(note).toContain(
      "- Final reason: preparation-preflight failed: Unbuilt workspace dependency @directus/extensions. […]",
    );
    expect(note).not.toContain("src/cli/commands/add.ts");
  });

  it("flags repeated identical failures as repairs that never reached the cause", async () => {
    const root = await runRoot();
    const entry = await writeRunEntry(root, "matrix-wave-13-ghostfolio", {
      "pipeline-run-manifest.json": failedManifest("preparation-preflight"),
      "repair-round-ledger.json": createRepairRoundLedger(
        ghostfolioWave13.rounds as RepairRoundSource[],
      ),
    });

    const note = await draftWaveDiagnosisNote([entry]);

    expect(note).toMatch(/2 rounds .*identical/i);
  });

  it("takes the last failure from the failed stage's final validation attempt when no ledger exists", async () => {
    const root = await runRoot();
    const entry = await writeRunEntry(root, "matrix-wave-17-outline", {
      "pipeline-run-manifest.json": failedManifest("preparation-preflight"),
      "validation-attempts/preparation-preflight/attempt-9.json": {
        failureClassification: "runtime crash",
        logsSummary: "An earlier failure that a later attempt superseded.",
      },
      "validation-attempts/preparation-preflight/attempt-10.json": {
        failureClassification: "runtime crash",
        logsSummary:
          "\nServer exited before the readiness probe.\nStack below.",
      },
    });

    const note = await draftWaveDiagnosisNote([entry]);

    expect(note).toContain(
      "Last failure: Server exited before the readiness probe. [classification: runtime crash]",
    );
    expect(note).not.toContain("superseded");
  });

  it("reconstructs pre-ledger repair rounds from validation attempts, repair candidates, and the final manifest", async () => {
    const root = await runRoot();
    const failureAttempt = {
      failureClassification: "runtime-configuration error",
      logsSummary:
        "Runtime-configuration error: startCommandUsed runs dist/apps/api/main but no declared build produces it.",
      stage: "preparation-preflight",
      status: "failed",
    };
    const candidateAttempt = (buildCommandUsed: string) => ({
      candidate: {
        appDir: ".",
        buildCommandUsed,
        installCommandUsed: "npm ci --no-audit",
        ports: [3000],
        startCommandUsed: "npm run start",
      },
      status: "passed",
    });
    const entry = await writeRunEntry(root, "matrix-wave-13-preledger", {
      "pipeline-run-manifest.json": failedManifest("preparation-preflight"),
      "preparation-manifest.json": {
        appDir: ".",
        installCommandUsed: "npm ci --no-audit",
        ports: [3000],
        startCommandUsed: "npm run start",
      },
      "validation-attempts/preparation-preflight/attempt-1.json":
        failureAttempt,
      "validation-attempts/preparation-preflight/attempt-2.json":
        failureAttempt,
      "validation-attempts/preparation-preflight/attempt-3.json":
        failureAttempt,
      "agent-artifact-attempts/repo-preparation-runtime-repair/attempt-1.json":
        candidateAttempt("npm run nx -- run api:build"),
      "agent-artifact-attempts/repo-preparation-runtime-repair/attempt-2.json":
        candidateAttempt("npm run build:production"),
    });

    const note = await draftWaveDiagnosisNote([entry]);

    expect(note).toContain(
      "Repair rounds (reconstructed from pre-ledger artifacts): 2",
    );
    expect(note).toContain("`buildCommandUsed`");
    expect(note).toMatch(/dropped/i);
    expect(note).toMatch(/2 rounds .*identical/i);
  });

  it("drafts a reviewable note even when artifacts are missing or malformed", async () => {
    const root = await runRoot();
    const bareEntry = join(root, "matrix-wave-17-bare");
    await mkdir(bareEntry, { recursive: true });
    const brokenEntry = await writeRunEntry(root, "matrix-wave-17-broken", {
      "repair-round-ledger.json": "{ not json",
    });

    const note = await draftWaveDiagnosisNote([bareEntry, brokenEntry]);

    expect(note).toContain("matrix-wave-17-bare");
    expect(note).toContain("matrix-wave-17-broken");
    expect(note).toMatch(/no .makeademo artifacts/i);
    expect(note).toMatch(/unreadable/i);
  });

  it("reports a passed run without inventing findings", async () => {
    const root = await runRoot();
    const entry = await writeRunEntry(root, "matrix-wave-17-passed", {
      "pipeline-run-manifest.json": {
        finalStatus: "passed",
        stageStatuses: { "repo-preparation": "passed" },
      },
    });

    const note = await draftWaveDiagnosisNote([entry]);

    expect(note).toContain("Outcome: passed");
    expect(note).toMatch(/sketches\n\nNone\./);
  });
});

describe("resolveRunEntryDirectories", () => {
  it("expands a batch root into its run entries and keeps direct entry paths", async () => {
    const root = await runRoot();
    const directus = await writeRunEntry(root, "matrix-w13-directus", {
      "pipeline-run-manifest.json": failedManifest("preparation-preflight"),
    });
    const ghostfolio = await writeRunEntry(root, "matrix-w13-ghostfolio", {
      "pipeline-run-manifest.json": failedManifest("preparation-preflight"),
    });
    await mkdir(join(root, "not-a-run-entry"), { recursive: true });
    await writeFile(join(root, "matrix-report-w13.json"), "{}");

    await expect(
      resolveRunEntryDirectories([root, ghostfolio]),
    ).resolves.toEqual([directus, ghostfolio]);
  });

  it("returns no entries for a directory holding neither run artifacts nor entries", async () => {
    const root = await runRoot();

    await expect(resolveRunEntryDirectories([root])).resolves.toEqual([]);
  });
});
