import { describe, expect, it } from "vitest";
import { appendLifecycleCommandMutationEvidence } from "./lifecycle-mutation-evidence";

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
