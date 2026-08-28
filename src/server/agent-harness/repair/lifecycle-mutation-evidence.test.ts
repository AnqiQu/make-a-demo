import { describe, expect, it } from "vitest";
import {
  appendLifecycleCommandMutationEvidence,
  appendLifecycleFragmentDivergenceEvidence,
  appendPassingLifecycleDivergenceEvidence,
} from "./lifecycle-mutation-evidence";

function installFailure(overrides?: {
  failureClassification?: string;
  logsSummary?: string;
}) {
  return {
    failureClassification:
      overrides?.failureClassification ?? "install failure",
    logsSummary:
      overrides?.logsSummary ??
      "Install command failed: error: lockfile had changes, but lockfile is frozen",
    stage: "preparation-preflight",
    suggestedRepairHints: ["existing hint"],
  };
}

function lifecycle(overrides?: {
  buildCommandUsed?: string | null;
  dataStrategy?: {
    migrationCommand?: string;
    rung: string;
    seedCommand?: string;
    service: string;
  }[];
  installCommandUsed?: string;
  startCommandUsed?: string;
}) {
  return {
    appDir: "apps/dashboard",
    installCommandUsed:
      overrides?.installCommandUsed ??
      "bun install --frozen-lockfile --filter=@midday/dashboard...",
    ports: [3000],
    startCommandUsed: overrides?.startCommandUsed ?? "bun run start",
    ...(overrides?.buildCommandUsed === undefined
      ? {}
      : { buildCommandUsed: overrides.buildCommandUsed }),
    ...(overrides?.dataStrategy === undefined
      ? {}
      : { dataStrategy: overrides.dataStrategy }),
  };
}

function round(input: {
  candidate?: Parameters<typeof lifecycle>[0];
  failureClassification?: string;
  round: number;
}) {
  return {
    candidateManifest: lifecycle(input.candidate),
    failureReport:
      input.failureClassification === undefined
        ? {}
        : { failureClassification: input.failureClassification },
    round: input.round,
  };
}

describe("appendLifecycleCommandMutationEvidence", () => {
  it("leads with the mutation delta when an earlier round carried the failing command in a different form", () => {
    // N171 (midday, wave-19): rounds 1-2 declared the unfiltered install and
    // failed at fidelity; the resolver's filtered form then failed install in
    // rounds 3-5 and the repair evidence never surfaced the delta.
    const failure = installFailure();

    const enriched = appendLifecycleCommandMutationEvidence({
      failure,
      preparationManifest: lifecycle(),
      repairRounds: [
        round({
          candidate: { installCommandUsed: "bun install --frozen-lockfile" },
          failureClassification: "product fidelity violation",
          round: 1,
        }),
        round({ failureClassification: "install failure", round: 2 }),
      ],
    });

    const [headline] = enriched.logsSummary.split("\n");
    expect(headline).toContain("Lifecycle command mutation suspected");
    expect(headline).toContain(
      "install command `bun install --frozen-lockfile --filter=@midday/dashboard...`",
    );
    expect(headline).toContain("`bun install --frozen-lockfile`");
    expect(headline).toContain("round-1 repair");
    expect(headline).toContain("repairing a different failure");
    expect(headline).toContain("product fidelity violation");
    expect(headline).toMatch(/revert|justify/i);
    expect(enriched.logsSummary).toContain(failure.logsSummary);
    expect(enriched.suggestedRepairHints).toEqual(["existing hint"]);
    expect(enriched.failureClassification).toBe("install failure");
  });

  it("anchors on the most recent round that did not blame the same lifecycle field", () => {
    // Rounds 3-5 also failed install, so their forms were never carried past
    // the install gate either; round 2's fidelity failure is the anchor.
    const failure = installFailure();

    const enriched = appendLifecycleCommandMutationEvidence({
      failure,
      preparationManifest: lifecycle(),
      repairRounds: [
        round({
          candidate: { installCommandUsed: "npm install" },
          failureClassification: "product fidelity violation",
          round: 1,
        }),
        round({
          candidate: { installCommandUsed: "bun install --frozen-lockfile" },
          failureClassification: "app route not discoverable",
          round: 2,
        }),
        round({ failureClassification: "install failure", round: 3 }),
        round({ failureClassification: "install failure", round: 4 }),
      ],
    });

    expect(enriched.logsSummary).toContain("round-2 repair");
    expect(enriched.logsSummary).toContain("`bun install --frozen-lockfile`");
    expect(enriched.logsSummary).not.toContain("npm install");
  });

  it("scans past a non-blaming round that already declared the failing form", () => {
    // The mutation happened between rounds 1 and 2, so round 2's identical
    // form is no anchor — the pre-mutation form lives in round 1.
    const failure = installFailure();

    const enriched = appendLifecycleCommandMutationEvidence({
      failure,
      preparationManifest: lifecycle(),
      repairRounds: [
        round({
          candidate: { installCommandUsed: "bun install --frozen-lockfile" },
          failureClassification: "product fidelity violation",
          round: 1,
        }),
        round({
          failureClassification: "app route not discoverable",
          round: 2,
        }),
      ],
    });

    expect(enriched.logsSummary).toContain("round-1 repair");
    expect(enriched.logsSummary).toContain("product fidelity violation");
    expect(enriched.logsSummary).toContain("`bun install --frozen-lockfile`");
  });

  it("treats a round that failed on a different lifecycle command as a valid anchor", () => {
    const failure = installFailure({
      failureClassification: "start failure",
      logsSummary: "Start command exited before listening on port 3000",
    });

    const enriched = appendLifecycleCommandMutationEvidence({
      failure,
      preparationManifest: lifecycle({
        startCommandUsed: "bun run start:demo",
      }),
      repairRounds: [
        round({
          candidate: { startCommandUsed: "bun run start" },
          failureClassification: "install failure",
          round: 1,
        }),
      ],
    });

    expect(enriched.logsSummary).toContain(
      "start command `bun run start:demo` differs from `bun run start`",
    );
  });

  it("returns the failure unchanged when the earlier round carried the same form", () => {
    const failure = installFailure();

    const enriched = appendLifecycleCommandMutationEvidence({
      failure,
      preparationManifest: lifecycle(),
      repairRounds: [
        round({
          failureClassification: "product fidelity violation",
          round: 1,
        }),
      ],
    });

    expect(enriched).toBe(failure);
  });

  it("returns the failure unchanged when the classification blames no lifecycle command", () => {
    const failure = installFailure({
      failureClassification: "product fidelity violation",
    });

    const enriched = appendLifecycleCommandMutationEvidence({
      failure,
      preparationManifest: lifecycle(),
      repairRounds: [
        round({
          candidate: { installCommandUsed: "bun install --frozen-lockfile" },
          failureClassification: "install failure",
          round: 1,
        }),
      ],
    });

    expect(enriched).toBe(failure);
  });

  it("returns the failure unchanged when no repair round has completed", () => {
    const failure = installFailure();

    expect(
      appendLifecycleCommandMutationEvidence({
        failure,
        preparationManifest: lifecycle(),
        repairRounds: [],
      }),
    ).toBe(failure);
  });

  it("returns the failure unchanged when every earlier round blamed the same command", () => {
    const failure = installFailure();

    const enriched = appendLifecycleCommandMutationEvidence({
      failure,
      preparationManifest: lifecycle(),
      repairRounds: [
        round({
          candidate: { installCommandUsed: "bun install --frozen-lockfile" },
          failureClassification: "install failure",
          round: 1,
        }),
        round({
          candidate: { installCommandUsed: "npm install" },
          failureClassification: "install failure",
          round: 2,
        }),
      ],
    });

    expect(enriched).toBe(failure);
  });

  it("leaves unbuilt-workspace-dependency failures to the graph-build escalation", () => {
    const failure = installFailure({
      failureClassification: "unbuilt workspace dependency",
    });

    const enriched = appendLifecycleCommandMutationEvidence({
      failure,
      preparationManifest: lifecycle({ buildCommandUsed: "bun run build" }),
      repairRounds: [
        round({
          candidate: { buildCommandUsed: "turbo build" },
          failureClassification: "product fidelity violation",
          round: 1,
        }),
      ],
    });

    expect(enriched).toBe(failure);
  });

  it("names an earlier round's omitted build command instead of comparing against nothing", () => {
    const failure = installFailure({
      failureClassification: "build failure",
      logsSummary: "Build command failed: tsc exited 2",
    });

    const enriched = appendLifecycleCommandMutationEvidence({
      failure,
      preparationManifest: lifecycle({ buildCommandUsed: "bun run build" }),
      repairRounds: [
        round({
          failureClassification: "product fidelity violation",
          round: 1,
        }),
      ],
    });

    expect(enriched.logsSummary).toContain(
      "build command `bun run build` differs from no declared build command",
    );
  });

  it("compares provisioned-service migration commands across rounds by service", () => {
    const failure = installFailure({
      failureClassification: "service migration failure",
      logsSummary: "Migration command failed: relation already exists",
    });

    const enriched = appendLifecycleCommandMutationEvidence({
      failure,
      preparationManifest: lifecycle({
        dataStrategy: [
          {
            migrationCommand: "bun run db:push --force",
            rung: "provisioned-service",
            service: "postgres",
          },
          { rung: "declared-stub", service: "redis" },
        ],
      }),
      repairRounds: [
        round({
          candidate: {
            dataStrategy: [
              {
                migrationCommand: "bun run db:migrate",
                rung: "provisioned-service",
                service: "postgres",
              },
            ],
          },
          failureClassification: "product fidelity violation",
          round: 1,
        }),
      ],
    });

    expect(enriched.logsSummary).toContain(
      "provisioned-service migration commands postgres: `bun run db:push --force` differs from postgres: `bun run db:migrate`",
    );
    expect(enriched.logsSummary).not.toContain("redis");
  });
});

describe("appendPassingLifecycleDivergenceEvidence", () => {
  it("leads with the last passing form when the failing command diverges from it", () => {
    // N178 (midday, wave-21): the filtered install was declared from round
    // one, so the within-run mutation scan had no green baseline — but the
    // last passing digest knew the unfiltered form, one JSONL line away.
    const failure = installFailure();

    const enriched = appendPassingLifecycleDivergenceEvidence({
      failure,
      lastPassingLifecycle: lifecycle({
        installCommandUsed: "bun install --frozen-lockfile",
      }),
      preparationManifest: lifecycle(),
    });

    const [headline] = enriched.logsSummary.split("\n");
    expect(headline).toContain("Cross-run lifecycle divergence");
    expect(headline).toContain(
      "install command `bun install --frozen-lockfile --filter=@midday/dashboard...`",
    );
    expect(headline).toContain("`bun install --frozen-lockfile`");
    expect(headline).toContain("last passing run");
    expect(headline).toMatch(/try|justify/i);
    expect(enriched.logsSummary).toContain(failure.logsSummary);
    expect(enriched.suggestedRepairHints).toEqual(["existing hint"]);
    expect(enriched.failureClassification).toBe("install failure");
  });

  it("returns the failure unchanged when it matches the last passing form", () => {
    const failure = installFailure();

    expect(
      appendPassingLifecycleDivergenceEvidence({
        failure,
        lastPassingLifecycle: lifecycle(),
        preparationManifest: lifecycle(),
      }),
    ).toBe(failure);
  });

  it("returns the failure unchanged when no passing lifecycle is recorded", () => {
    const failure = installFailure();

    expect(
      appendPassingLifecycleDivergenceEvidence({
        failure,
        lastPassingLifecycle: undefined,
        preparationManifest: lifecycle(),
      }),
    ).toBe(failure);
  });

  it("returns the failure unchanged when the classification blames no lifecycle command", () => {
    // "unbuilt workspace dependency" stays with the graph-build
    // escalation; a cross-run form comparison would contradict it.
    const failure = installFailure({
      failureClassification: "unbuilt workspace dependency",
    });

    expect(
      appendPassingLifecycleDivergenceEvidence({
        failure,
        lastPassingLifecycle: lifecycle({
          installCommandUsed: "bun install --frozen-lockfile",
        }),
        preparationManifest: lifecycle(),
      }),
    ).toBe(failure);
  });

  it("names a missing build command against the passing run's declared build", () => {
    const failure = installFailure({
      failureClassification: "build failure",
      logsSummary: "Build produced no admin bundle.",
    });

    const enriched = appendPassingLifecycleDivergenceEvidence({
      failure,
      lastPassingLifecycle: lifecycle({ buildCommandUsed: "yarn run build" }),
      preparationManifest: lifecycle(),
    });

    const [headline] = enriched.logsSummary.split("\n");
    expect(headline).toContain("build command no declared build command");
    expect(headline).toContain("`yarn run build`");
  });
});

describe("appendLifecycleFragmentDivergenceEvidence", () => {
  it("leads with the closest-known form when the failing command diverges from it", () => {
    // N179 (twenty): rounds failed under yarn run build while the round-4
    // nx graph build — the only declaration that ever moved the failure —
    // sat in a prior run's digest with no pass to cite.
    const failure = installFailure({
      failureClassification: "build failure",
      logsSummary: "Build failed: cannot find module twenty-shared/dist.",
    });

    const enriched = appendLifecycleFragmentDivergenceEvidence({
      failure,
      lastLifecycleFragment: lifecycle({
        buildCommandUsed: "yarn nx run-many -t build",
      }),
      preparationManifest: lifecycle({ buildCommandUsed: "yarn run build" }),
    });

    const [headline] = enriched.logsSummary.split("\n");
    expect(headline).toContain("Closest-known lifecycle divergence");
    expect(headline).toContain("build command `yarn run build`");
    expect(headline).toContain("`yarn nx run-many -t build`");
    expect(headline).toContain("closest this repository has come");
    expect(headline).toMatch(/declare|justify/i);
    expect(enriched.logsSummary).toContain(failure.logsSummary);
    expect(enriched.suggestedRepairHints).toEqual(["existing hint"]);
  });

  it("returns the failure unchanged when it matches the closest-known form", () => {
    const failure = installFailure();

    expect(
      appendLifecycleFragmentDivergenceEvidence({
        failure,
        lastLifecycleFragment: lifecycle(),
        preparationManifest: lifecycle(),
      }),
    ).toBe(failure);
  });

  it("returns the failure unchanged when no fragment is recorded", () => {
    const failure = installFailure();

    expect(
      appendLifecycleFragmentDivergenceEvidence({
        failure,
        lastLifecycleFragment: undefined,
        preparationManifest: lifecycle(),
      }),
    ).toBe(failure);
  });

  it("returns the failure unchanged when the classification blames no lifecycle command", () => {
    const failure = installFailure({
      failureClassification: "unbuilt workspace dependency",
    });

    expect(
      appendLifecycleFragmentDivergenceEvidence({
        failure,
        lastLifecycleFragment: lifecycle({
          installCommandUsed: "yarn install --immutable",
        }),
        preparationManifest: lifecycle(),
      }),
    ).toBe(failure);
  });
});
