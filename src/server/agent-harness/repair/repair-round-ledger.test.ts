import directusWave13 from "./fixtures/directus-wave-13.json";
import directusWave14 from "./fixtures/directus-wave-14.json";
import ghostfolioWave13 from "./fixtures/ghostfolio-wave-13.json";
import outlineWave14 from "./fixtures/outline-wave-14.json";
import {
  type RepairRoundSource,
  createRepairRoundLedger,
} from "./repair-round-ledger";

// Minimal artifact extracts from matrix-2026-08-15T05-38-26-724Z-ghostfolio
// and matrix-2026-08-15T05-38-26-724Z-directus (wave 13), plus
// matrix-2026-08-17T04-03-08-593Z-directus and
// matrix-2026-08-17T04-03-08-593Z-outline (wave 14).
describe("createRepairRoundLedger", () => {
  it("preserves the candidate-versus-resolved build drop from ghostfolio wave 13", () => {
    const ledger = createRepairRoundLedger(
      ghostfolioWave13.rounds as RepairRoundSource[],
    );

    expect(ledger.rounds).toHaveLength(2);
    expect(ledger.rounds[0]).toEqual({
      advice: null,
      budget: {
        bonusRounds: 0,
        fingerprintAttempts: 1,
        totalAttempts: 1,
      },
      candidateFingerprint:
        "4dcd1c311ff524314dc7b82ee8e7decf64766f88507aa101cb22b91bc08a372a",
      candidateLifecycle: {
        appDir: ".",
        buildCommandUsed: "npm run nx -- run api:build",
        installCommandUsed: "npm ci --no-audit",
        ports: [3000],
        startCommandUsed: "npm run start",
      },
      causalHeadline:
        "Runtime-configuration error: startCommandUsed runs dist/apps/api/main but no declared build produces it — declare the build that emits dist/apps/api/main, or start the dev server instead.",
      failingFeatureIds: [],
      failureClassification: "runtime-configuration error",
      outcomeOfAdvice: null,
      resolvedLifecycle: {
        appDir: ".",
        buildCommandUsed: null,
        installCommandUsed: "npm ci --no-audit",
        ports: [3000],
        startCommandUsed: "npm run start",
      },
      round: 1,
      stage: "preparation-preflight",
      workspaceDiffSummary: {
        changedPathCount: 5,
        topLevelDirs: [".", "apps", "libs", "prisma"],
      },
    });
  });

  it("joins the directus wave-13 single-package dependency chain", () => {
    const ledger = createRepairRoundLedger(
      directusWave13.rounds as RepairRoundSource[],
    );

    expect(ledger.rounds.map((round) => round.causalHeadline)).toEqual([
      expect.stringContaining("@directus/extensions"),
      expect.stringContaining("@directus/constants"),
    ]);
    expect(ledger.rounds[1]?.workspaceDiffSummary).toEqual({
      changedPathCount: 3,
      topLevelDirs: ["app"],
    });
  });

  it("retains the directus wave-14 three-round dependency arc", () => {
    const ledger = createRepairRoundLedger(
      directusWave14.rounds as RepairRoundSource[],
    );

    expect(ledger.rounds.map((round) => round.causalHeadline)).toEqual([
      expect.stringContaining("@directus/extensions"),
      expect.stringContaining("@directus/constants"),
      expect.stringContaining("@directus/extensions"),
    ]);
    expect(ledger.rounds[2]).toMatchObject({
      budget: { fingerprintAttempts: 2, totalAttempts: 3 },
      candidateLifecycle: { buildCommandUsed: null },
      resolvedLifecycle: {
        buildCommandUsed:
          "pnpm --recursive --filter=@directus/app... run build",
      },
    });
  });

  it("carries strategist memos and bonus reasons into the comparative record", () => {
    const source = (
      ghostfolioWave13.rounds as RepairRoundSource[]
    )[0] as RepairRoundSource;
    const ledger = createRepairRoundLedger([
      {
        ...source,
        advice: {
          applied: true,
          kind: "spend-bonus-round",
          memo: "This repo converges slowly; the seed path is the long pole.",
          textDigest: "Round 5 moved the failure; one more converges.",
        },
        outcomeOfAdvice: "failure-moved",
      },
    ]);

    expect(ledger.rounds[0]?.advice).toEqual({
      applied: true,
      kind: "spend-bonus-round",
      memo: "This repo converges slowly; the seed path is the long pole.",
      textDigest: "Round 5 moved the failure; one more converges.",
    });
  });

  it("records outline wave-14's repeated evidence-citation failures", () => {
    const ledger = createRepairRoundLedger(
      outlineWave14.rounds as RepairRoundSource[],
    );

    expect(ledger.rounds).toHaveLength(3);
    expect(ledger.rounds.map((round) => round.failureClassification)).toEqual([
      "invalid-schema",
      "invalid-schema",
      "invalid-schema",
    ]);
    expect(ledger.rounds.map((round) => round.causalHeadline)).toEqual([
      expect.stringContaining("demo:dev"),
      expect.stringContaining("outside the screened repository"),
      expect.stringContaining("file added during preparation"),
    ]);
  });
});
