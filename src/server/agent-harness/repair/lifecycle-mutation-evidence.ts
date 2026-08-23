/**
 * The lifecycle command surface a preparation failure can blame. Structural
 * on purpose: both the full PreparationManifest and the repair ledger's
 * candidate lifecycles satisfy it, so the comparison always reads the
 * agent-declared fields regardless of which seam supplied the manifest.
 */
type LifecycleCommandCarrier = {
  buildCommandUsed?: string | null;
  dataStrategy?: readonly {
    migrationCommand?: string;
    rung: string;
    seedCommand?: string;
    service: string;
  }[];
  installCommandUsed: string;
  startCommandUsed: string;
};

/** One completed repair round, reduced to what the mutation scan reads. */
type LifecycleMutationRound = {
  candidateManifest: LifecycleCommandCarrier;
  failureReport: { failureClassification?: string };
  round: number;
};

type LifecycleField = "build" | "install" | "migration" | "seed" | "start";

// "unbuilt workspace dependency" is deliberately unmapped: its repair
// steering is owned by the workspace graph-build escalation, and steering
// the same failure toward both a graph build and a command revert would
// contradict itself. "service start failure" is also unmapped because the
// harness, not the manifest, owns provisioned-service startup.
const lifecycleFieldByClassification: Record<string, LifecycleField> = {
  "build failure": "build",
  "install failure": "install",
  "service migration failure": "migration",
  "service seed failure": "seed",
  "start failure": "start",
};

const lifecycleFieldLabels: Record<LifecycleField, string> = {
  build: "build command",
  install: "install command",
  migration: "provisioned-service migration commands",
  seed: "provisioned-service seed commands",
  start: "start command",
};

function describeProvisionedCommands(
  manifest: LifecycleCommandCarrier,
  key: "migrationCommand" | "seedCommand",
): string {
  const declared = [...(manifest.dataStrategy ?? [])]
    .filter((entry) => entry.rung === "provisioned-service")
    .sort((left, right) => left.service.localeCompare(right.service))
    .map((entry) => {
      const command = entry[key];
      return command === undefined
        ? `${entry.service}: none`
        : `${entry.service}: \`${command}\``;
    });
  return declared.length === 0 ? "none declared" : declared.join("; ");
}

function readLifecycleForm(
  manifest: LifecycleCommandCarrier,
  field: LifecycleField,
): string {
  switch (field) {
    case "build":
      return manifest.buildCommandUsed == null
        ? "no declared build command"
        : `\`${manifest.buildCommandUsed}\``;
    case "install":
      return `\`${manifest.installCommandUsed}\``;
    case "start":
      return `\`${manifest.startCommandUsed}\``;
    case "migration":
      return describeProvisionedCommands(manifest, "migrationCommand");
    case "seed":
      return describeProvisionedCommands(manifest, "seedCommand");
  }
}

/**
 * Leads a lifecycle-command failure's evidence with the command's own
 * mutation history (N171): when the failing command was carried in a
 * different form by an earlier repair round whose failure lay elsewhere,
 * the delta is prepended to `logsSummary` — naming the earlier form, the
 * round that carried it, and the revert-or-justify instruction — so the
 * repair agent confronts the mutation before the symptom (midday, wave-19:
 * the unfiltered install of rounds 1-2 became a fatally filtered form in
 * rounds 3-5 and no evidence ever surfaced the change).
 *
 * The anchor is the most recent round that declared the command in a
 * different form while its repair addressed a failure that does not blame
 * the same lifecycle field. Rounds triggered by a same-field failure never
 * qualify: changing this command was that repair's assignment, so its
 * declared form is no evidence of an unintended mutation, and it is no
 * revert target either. Rounds that already declared the failing form are
 * scanned past, because the mutation happened before them. Candidate
 * (agent-declared) lifecycles are compared, not resolved ones, so resolver
 * rewrites — exactly midday's mutation — surface as a delta against the
 * form the agent last declared. Returns the failure unchanged when its
 * classification blames no lifecycle command or no qualifying round
 * exists. Callers must fingerprint and ledger the raw report — the
 * enriched copy is prompt-facing evidence only, and persisting it would
 * corrupt fingerprint repeat-detection and ledger headlines.
 */
export function appendLifecycleCommandMutationEvidence<
  T extends { failureClassification?: string; logsSummary: string },
>(input: {
  failure: T;
  preparationManifest: LifecycleCommandCarrier;
  repairRounds: readonly LifecycleMutationRound[];
}): T {
  const field =
    lifecycleFieldByClassification[input.failure.failureClassification ?? ""];
  if (field === undefined) {
    return input.failure;
  }
  const currentForm = readLifecycleForm(input.preparationManifest, field);
  let priorRound: LifecycleMutationRound | undefined;
  let earlierForm: string | undefined;
  for (let index = input.repairRounds.length - 1; index >= 0; index -= 1) {
    const candidate = input.repairRounds[index];
    if (candidate === undefined) {
      continue;
    }
    const candidateField =
      lifecycleFieldByClassification[
        candidate.failureReport.failureClassification ?? ""
      ];
    if (candidateField === field) {
      continue;
    }
    const candidateForm = readLifecycleForm(candidate.candidateManifest, field);
    if (candidateForm !== currentForm) {
      priorRound = candidate;
      earlierForm = candidateForm;
      break;
    }
  }
  if (priorRound === undefined || earlierForm === undefined) {
    return input.failure;
  }
  const label = lifecycleFieldLabels[field];
  const repairedClassification =
    priorRound.failureReport.failureClassification ?? "unclassified";
  return {
    ...input.failure,
    logsSummary: [
      `Lifecycle command mutation suspected: the failing ${label} ${currentForm} differs from ${earlierForm}, which the round-${priorRound.round} repair declared while repairing a different failure (${repairedClassification}). First revert the ${label} to the round-${priorRound.round} form, or justify why the mutated form must stay.`,
      "",
      input.failure.logsSummary,
    ].join("\n"),
  };
}
