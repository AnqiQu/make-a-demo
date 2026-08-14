import { escapeRegExp } from "../../shared/text/escape-regexp";
import { isEnvironmentSecretFileName } from "../repo-security/secret-predicates";
import type {
  FeatureVerdict,
  FidelityAdjudicationRecord,
  FidelityAdjudicationVerdict,
  PreparationManifest,
  ValidationReport,
} from "../schemas/artifacts";
import { analyzeDemoGateUsage } from "./demo-gate-analysis";
import type { PreparationWorkspaceDiff } from "./preparation-workspace-diff";

const dependencyConfigurationNames = new Set([
  ".npmrc",
  ".pnpmfile.cjs",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml",
  "pnpmfile.cjs",
]);

const lockfileNames = new Set([
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/** Summarizes file-content changes relevant to a dependency repair transaction. */
export function readDependencyRepairDelta(
  baseline: PreparationWorkspaceDiff,
  candidate: PreparationWorkspaceDiff,
) {
  const changedPaths = [
    ...new Set([
      ...Object.keys(baseline.changedFileSha256),
      ...Object.keys(candidate.changedFileSha256),
    ]),
  ].filter(
    (path) =>
      baseline.changedFileSha256[path] !== candidate.changedFileSha256[path],
  );
  return {
    changedPaths,
    dependencyInputsChanged: changedPaths.some(isDependencyRepairInputPath),
    onlyLockfiles:
      changedPaths.length > 0 &&
      changedPaths.every(isPackageManagerLockfilePath),
  };
}

/**
 * One candidate fidelity violation from the pure generator. `path` names the
 * file whose diff carries the evidence, when the violation is file-scoped —
 * adjudication verifies a judge's quoted evidence against exactly that
 * file's diff section.
 */
export type FidelityCandidate = {
  /** Structural manifest contradictions bypass heuristic adjudication. */
  deterministic?: true;
  hint: string;
  message: string;
  path?: string;
};

/**
 * Verifies that Repo Preparation adapted the screened product rather than
 * replacing it with a newly authored demo application. During dependency
 * repair, executable source must remain unchanged from the accepted baseline.
 * Auth and integration edits must conditionally use a source-backed demo gate.
 * Presentation files accept only external-asset localization or a demo-gated
 * wrap that re-introduces existing markup without adding new presentation.
 */
type FidelityViolation = FidelityCandidate;

const repairHints = {
  adaptOriginal:
    "Adapt the original application; do not create replacement servers, pages, styles, or commands.",
  dependencyScope:
    "Change only package manifests or recognized package-manager configuration during dependency repair.",
  envUsed:
    "Set demo environment through envUsed in the preparation manifest, not created env files.",
  gate: "Read the active MAKEADEMO_DEMO flag from envUsed directly or through one shared helper imported in the changed file, then conditionally select the demo path while preserving the normal behavior.",
  keepWorkspaces:
    "Keep the original workspace configuration; scope commands to the app instead.",
  buildAppUnderTest:
    "Keep the selected app's build script building the app itself — optionally after its workspace dependencies; a build redirected entirely at other packages exits green while leaving the app unbuilt.",
  preserveBehavior:
    "Re-add the removed lines on the non-demo branch; the gate must wrap original behavior, not delete it.",
  preserveUi:
    "Revert presentation changes; keep the original components, styles, and brand assets.",
  seam: "Move the change into an authentication, data, service, or configuration seam and gate it.",
  selfRequest:
    "Import the fixture or adapter directly instead of requesting your own listener.",
  packageManagerIdentity:
    "Keep the repository's packageManager pin and manager configuration; adapt the demo within the detected package manager instead of switching or unpinning it.",
  truthfulManifest:
    "Complete the preparation so the claimed fixtures and replacements exist in the workspace, or correct the manifest to describe the actual prepared state.",
  statusHonesty:
    "Fix the condition that produces the error response instead of rewriting its status code; a success status over a broken state falsifies the harness's probe without repairing the feature.",
  observedAuthWall:
    "Prepare the narrowest demo-gated bypass or demo identity through an existing auth seam, record it in the feature's authStrategy, and keep the normal authentication path unchanged when the gate is off.",
} as const;

// An HTTP response-status write: res.status(...), sendStatus, writeHead,
// statusCode assignment, or a status: field in a response init.
const statusWritePattern =
  /(?:\.status\s*\(|\.sendStatus\s*\(|writeHead\s*\(|statusCode\s*=|\bstatus\s*:)\s*([1-9]\d{2})\b/g;

function readStatusWrites(lines: string[]): Set<number> {
  return new Set(
    lines.flatMap((line) =>
      [...line.matchAll(statusWritePattern)].map((match) => Number(match[1])),
    ),
  );
}

export function validatePreparationFidelity(input: {
  dependencyRepair?: boolean;
  preparationManifest: PreparationManifest;
  priorFeatureVerdicts?: FeatureVerdict[];
  repairBaseline?: PreparationWorkspaceDiff;
  repoSourceFiles: ReadonlyMap<string, string | undefined>;
  workspaceDiff: PreparationWorkspaceDiff;
}): ValidationReport {
  return createPreparationFidelityReport({
    candidates: readPreparationFidelityCandidates(input),
  });
}

/**
 * The pure candidate generator behind preparation-fidelity validation: every
 * returned candidate is a proposed veto, and callers with an adjudication
 * seam may have an agent judge confirm or overturn each one before the
 * verdict becomes a report. Candidates carry the evidence-bearing file path
 * whenever the violation is file-scoped.
 */
export function readPreparationFidelityCandidates(input: {
  dependencyRepair?: boolean;
  preparationManifest: PreparationManifest;
  priorFeatureVerdicts?: FeatureVerdict[];
  repairBaseline?: PreparationWorkspaceDiff;
  repoSourceFiles: ReadonlyMap<string, string | undefined>;
  workspaceDiff: PreparationWorkspaceDiff;
}): FidelityCandidate[] {
  const violations: FidelityViolation[] = [];
  const hasStubDeliveryMechanism =
    input.preparationManifest.mocksAndFixturesAdded.length > 0 ||
    input.preparationManifest.localDemoModeChanges.length > 0 ||
    readConfiguredDemoFlags(input.preparationManifest).length > 0;
  for (const declaration of input.preparationManifest.dataStrategy ?? []) {
    if (
      declaration.rung !== "client-stub" &&
      declaration.rung !== "declared-stub"
    ) {
      continue;
    }
    const detailDeclaresAbsence =
      declaration.rung === "declared-stub" &&
      declaresMissingStubMechanism(declaration.detail);
    if (hasStubDeliveryMechanism && !detailDeclaresAbsence) continue;
    violations.push({
      deterministic: true,
      hint: repairHints.truthfulManifest,
      message: `Data strategy rung ${declaration.rung} for service ${declaration.service} is missing a delivery mechanism in this manifest${detailDeclaresAbsence ? `; its own detail explicitly says the mechanism is absent (${JSON.stringify(declaration.detail)})` : ""}. Record a concrete mocksAndFixturesAdded or localDemoModeChanges entry, or an active MakeADemo delivery gate in envUsed, and make the declaration describe that mechanism.`,
    });
  }
  // A manifest may only claim prepared content the workspace carries:
  // give-up repairs after agent stalls wrote fixture claims onto empty
  // diffs (excalidraw, ghostfolio 2026-08-07), and the hollow prep passed
  // every gate until capture. Added fixtures and replaced services require
  // at least one repo change; env-only demo modes (localDemoModeChanges
  // enacted through envUsed) legitimately need none.
  if (input.workspaceDiff.changedPaths.length === 0) {
    const unsupportedClaims = [
      ...input.preparationManifest.mocksAndFixturesAdded,
      ...input.preparationManifest.blockedExternalServicesReplaced,
    ];
    if (unsupportedClaims.length > 0) {
      violations.push({
        hint: repairHints.truthfulManifest,
        message: `The manifest claims prepared content the workspace does not contain: ${unsupportedClaims.join(
          "; ",
        )}. The workspace diff is empty.`,
      });
    }
    // The inverse sham passes the check above by claiming nothing at all:
    // midday's accepted manifest carried an empty diff, empty demo-mode and
    // fixture declarations, empty seams — and two demoable features
    // (2026-08-09). "Preserves the screened application" is trivially true
    // of a preparation that changed nothing, so the vacuous claim must
    // reach the judge instead of passing silently; a repo that genuinely
    // demos unchanged survives adjudication by saying so.
    const featureInventory =
      input.preparationManifest.productContext.featureInventory;
    if (
      unsupportedClaims.length === 0 &&
      featureInventory.length > 0 &&
      input.preparationManifest.localDemoModeChanges.length === 0 &&
      featureInventory.every(
        (feature) => (feature.dataSeams ?? []).length === 0,
      )
    ) {
      violations.push({
        hint: repairHints.truthfulManifest,
        message: `The workspace diff is empty and the manifest declares no local demo modes, added fixtures, or data seams, yet it claims ${featureInventory.length} demoable feature(s): ${featureInventory
          .map(({ id }) => id)
          .join(
            ", ",
          )}. A preparation that changed nothing must record how those features run offline — localDemoModeChanges enacted through envUsed — or actually prepare them.`,
      });
    }
  }
  // Declared data seams are referential claims (N100): the fixture module
  // must be a file the preparation actually created or changed, and the
  // replaced file must exist in the repo or the diff. A seam declared over
  // nothing is the hollow-manifest class again, one level down.
  const changedRepoPaths = new Set(
    input.workspaceDiff.changedPaths.map(toRepoRelativePath),
  );
  for (const feature of input.preparationManifest.productContext
    .featureInventory) {
    for (const seam of feature.dataSeams ?? []) {
      if (!changedRepoPaths.has(seam.fixtureModule)) {
        violations.push({
          hint: repairHints.truthfulManifest,
          message: `Feature ${feature.id} declares data seam fixture module ${seam.fixtureModule}, but the preparation never created or changed that file. Author the fixture literal there and return it from ${seam.functionName} under the demo gate, or correct the declaration.`,
        });
      }
      if (
        !changedRepoPaths.has(seam.path) &&
        !input.repoSourceFiles.has(seam.path)
      ) {
        violations.push({
          hint: repairHints.truthfulManifest,
          message: `Feature ${feature.id} declares data seam file ${seam.path}, which exists neither in the repository nor in the prepared diff.`,
        });
      }
      // A declared proof rests on what the fixture renders, so a fixture
      // shape nobody verified — or one the compiler rejected — cannot back
      // it: excalidraw claimed "Undo enabled immediately" over a not-run
      // probe while the harvested control state read [disabled]
      // (2026-08-08). Legitimately unprobeable repos survive the judge by
      // saying why the claim holds anyway.
      const probeOutcome = seam.shapeProbe?.trim().toLowerCase();
      if (
        feature.expectedProof !== undefined &&
        probeOutcome !== undefined &&
        (probeOutcome.startsWith("not-run") ||
          probeOutcome.startsWith("failed"))
      ) {
        violations.push({
          hint: repairHints.truthfulManifest,
          message: `Feature ${feature.id} declares an expectedProof observable state, but its data seam ${seam.path} records shapeProbe "${seam.shapeProbe}" — an unverified fixture shape cannot back a claimed observable state. Run the fixture-shape probe and record its outcome, or state in the probe entry why the claim holds without the compiler's check.`,
        });
      }
    }
  }
  // Exploration's own ledger beats the manifest's prose: a prior round's
  // feature verdict recording an auth wall disproves a manifest that still
  // declares the feature needs no auth handling (midday claimed
  // authStrategy "none" across surfaces exploration then found behind
  // login redirects, 2026-08-09). Features already declaring a strategy
  // are the strategy failing, not a false claim, and stay with repair.
  const inventoryById = new Map(
    input.preparationManifest.productContext.featureInventory.map(
      (feature) => [feature.id, feature] as const,
    ),
  );
  for (const priorVerdict of input.priorFeatureVerdicts ?? []) {
    if (priorVerdict.failedBecause !== "auth-wall") {
      continue;
    }
    const feature = inventoryById.get(priorVerdict.featureId);
    if (feature === undefined || feature.authStrategy !== "none") {
      continue;
    }
    violations.push({
      hint: repairHints.observedAuthWall,
      message: `The harness observed an authentication wall on feature ${
        feature.id
      }'s entry routes${
        priorVerdict.detail === undefined ? "" : ` (${priorVerdict.detail})`
      }, but the manifest still declares authStrategy "none" for it — the prepared app itself disproves the claim. Prepare a demo-gated bypass or demo identity for that surface, or correct the feature's entry paths.`,
    });
  }
  const repairPaths = readInvalidRepairPaths(input);
  const filePatches = parsePatchSections(input.workspaceDiff.patch);
  // Package-manager identity is backend territory: the detected manager
  // drives install, lockfile reconciliation, and the offline lifecycle.
  // outline's prep deleted the packageManager pin, silently downgrading
  // yarn berry to classic, and reconciliation ran the wrong manager
  // against the berry lockfile (2026-08-08). Pin changes and new
  // manager-config files are rejected; existing config files stay
  // editable for in-manager tweaks.
  for (const path of input.workspaceDiff.changedPaths.map(toRepoRelativePath)) {
    const fileName = path.split("/").at(-1) ?? path;
    const patch = filePatches.get(path) ?? emptyPatchSection;
    const changesManagerPin =
      fileName === "package.json" &&
      [...patch.added, ...patch.removed].some((line) =>
        line.includes('"packageManager"'),
      );
    const isManagerConfig =
      fileName === ".yarnrc" ||
      fileName === ".yarnrc.yml" ||
      fileName === ".npmrc";
    const createsManagerConfig =
      isManagerConfig && !input.repoSourceFiles.has(path);
    // Mutating identity-semantic keys inside an EXISTING manager config is
    // as identity-changing as pinning a different manager: twenty's agent
    // flipped .yarnrc.yml to nodeLinker: pnp / pnpMode: loose and slipped
    // the new-file check (2026-08-08 matrix). In-manager tweaks to other
    // keys stay legal per N74's landed contract.
    const mutatesManagerIdentity =
      isManagerConfig &&
      [...patch.added, ...patch.removed].some((line) =>
        /^\s*(?:nodeLinker|pnpMode|enableScripts|yarnPath|use-node-version|node-version)\s*[:=]/.test(
          line,
        ),
      );
    if (changesManagerPin || createsManagerConfig || mutatesManagerIdentity) {
      violations.push({
        hint: repairHints.packageManagerIdentity,
        message: `${path} changes the package-manager identity (the packageManager pin or a manager configuration file); the backend pins the detected manager and regenerates lockfiles with it.`,
        path,
      });
    }
    // Rewriting an error status into a success converts the harness's probe
    // into a lie while fixing nothing: ghost's maintenance page went
    // 503→200 and preflight turned green over the same broken state
    // (2026-08-08). Gated or not — the probe runs with the gate on — the
    // rewrite itself must reach the judge; a legitimate demo-mode toggle
    // survives by quoting the condition it actually changed.
    const removedErrorWrites = [...readStatusWrites(patch.removed)].filter(
      (code) => code >= 400,
    );
    const addedSuccessWrites = [...readStatusWrites(patch.added)].filter(
      (code) => code >= 200 && code < 300,
    );
    if (removedErrorWrites.length > 0 && addedSuccessWrites.length > 0) {
      violations.push({
        hint: repairHints.statusHonesty,
        message: `${path} rewrites an HTTP error status into a success: a ${removedErrorWrites.join(
          "/",
        )} response write was removed and a ${addedSuccessWrites.join(
          "/",
        )} one added. If the harness probed that route, the rewrite falsifies the probe instead of repairing what failed.`,
        path,
      });
    }
  }
  const demoGate = readDemoGateEvidence(
    input.preparationManifest,
    input.repoSourceFiles,
    input.workspaceDiff,
    filePatches,
  );
  // A conditional gate in a changed caller counts for the module it
  // references: demanding the conditional inside every changed file made
  // repairs shuttle one gate between two files until the budget died
  // (twenty, 2026-08-06/07 matrices). The other fidelity rungs — no new
  // presentation, preserved removals — still apply to the referenced file.
  const hasChangedCallerGate = (path: string): boolean => {
    const stem = (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, "");
    if (stem.length === 0) {
      return false;
    }
    const reference = new RegExp(
      `['"\`][^'"\`\\n]*${escapeRegExp(stem)}(?:\\.[a-z]+)?['"\`]`,
    );
    return input.workspaceDiff.changedPaths
      .map(toRepoRelativePath)
      .some((otherPath) => {
        const otherPatch = filePatches.get(otherPath);
        if (otherPath === path || otherPatch === undefined) {
          return false;
        }
        return (
          reference.test(stripComments(otherPatch.addedText)) &&
          hasConditionalDemoGate(
            otherPath,
            otherPatch,
            demoGate,
            input.repoSourceFiles.get(otherPath) ?? "",
          )
        );
      });
  };
  for (const path of repairPaths) {
    violations.push({
      hint: repairHints.dependencyScope,
      message: `${path} was modified by dependency installation repair, which may change only package manifests or recognized package-manager configuration.`,
      path,
    });
  }
  const createdPaths = input.workspaceDiff.changedPaths
    .map(toRepoRelativePath)
    .filter((path) => !input.repoSourceFiles.has(path));
  const modifiedOriginalPaths = input.workspaceDiff.changedPaths
    .map(toRepoRelativePath)
    .filter((path) => input.repoSourceFiles.has(path));

  for (const path of modifiedOriginalPaths) {
    if (repairPaths.has(path)) continue;
    // Lockfiles are backend-owned: install-window reconciliation rewrites
    // them between diff captures (making repair attribution unreliable), and
    // frozen installation re-derives their content from package.json.
    if (isPackageManagerLockfilePath(path)) continue;
    const patch = filePatches.get(path) ?? emptyPatchSection;
    if (addsServerSelfRequest(path, patch, input.preparationManifest.baseUrl)) {
      violations.push({
        hint: repairHints.selfRequest,
        message: `${path} calls back through its own listener from server-side code, which can recursively stall rendering. Use the fixture or adapter directly instead.`,
        path,
      });
      continue;
    }
    if (isFrameworkConfigPath(path)) continue;
    const originalSource = input.repoSourceFiles.get(path) ?? "";
    const addsPresentation = addsProductPresentation(patch, originalSource);
    const demoSeam = isDemoSeamPath(path);
    const authenticationAdaptation = isAuthenticationAdaptation(path, patch);
    const integrationAdaptation = isIntegrationAdaptation(path, patch);
    if (authenticationAdaptation || integrationAdaptation) {
      const violation = readGatedAdaptationViolation({
        addsPresentation,
        changedCallerGate: hasChangedCallerGate(path),
        demoGate,
        kind: authenticationAdaptation ? "authentication" : "integration",
        originalSource,
        patch,
        path,
      });
      if (violation !== undefined) {
        violations.push(violation);
      }
      continue;
    }
    if (demoSeam && !addsPresentation) {
      continue;
    }
    if (isProductPresentationPath(path)) {
      // A demo-gated wrap of existing markup preserves the product rather
      // than restyling it: sandboxed demos must be able to gate off analytics
      // beacons, chat widgets, and similar integrations that live in layouts.
      // Each failed wrap condition gets its own message; a collapsed
      // "modifies UI" veto misdirects repairs that only lack the gate.
      if (!onlyLocalizesExternalAssets(patch)) {
        const violation = readGatedAdaptationViolation({
          addsPresentation,
          changedCallerGate: hasChangedCallerGate(path),
          demoGate,
          kind: "presentation",
          originalSource,
          patch,
          path,
        });
        if (violation !== undefined) {
          violations.push(violation);
        }
      }
    } else if (isExecutableSourcePath(path) && !demoSeam) {
      violations.push({
        hint: repairHints.seam,
        message: `${path} modifies original feature logic outside an authentication, data, service, or configuration seam.`,
        path,
      });
    }
  }

  const packagePatch = filePatches.get("package.json") ?? emptyPatchSection;
  const resolvedStartCommands = readResolvedStartCommands(
    input.preparationManifest.startCommandUsed,
    input.repoSourceFiles,
    packagePatch.addedText,
  );
  for (const path of createdPaths) {
    if (repairPaths.has(path)) continue;
    const patch = filePatches.get(path) ?? emptyPatchSection;
    if (addsServerSelfRequest(path, patch, input.preparationManifest.baseUrl)) {
      violations.push({
        hint: repairHints.selfRequest,
        message: `${path} calls back through its own listener from server-side code, which can recursively stall rendering. Use the fixture or adapter directly instead.`,
        path,
      });
      continue;
    }
    if (
      isEnvironmentSecretFileName(path) &&
      containsAuthenticationTerms(patch.text)
    ) {
      violations.push({
        hint: repairHints.envUsed,
        message: `${path} changes authentication behavior through a created environment file; demo environment belongs in envUsed with a gated adaptation.`,
        path,
      });
    }
    // Content decides, path suggests: the path prior nominates the file, but
    // the veto requires positive presentation evidence in the file's own
    // content — markup/JSX/styling, or a file type that is presentation by
    // nature. Directory naming alone vetoed directus's one-line boolean gate
    // because its frontend package is named `app/` (2026-08-09), and
    // replacement UI must render something, so this loses no recall.
    if (
      isProductPresentationPath(path) &&
      !isVendoredAssetPath(path) &&
      (isPresentationByFileType(path) || addsProductPresentation(patch))
    ) {
      violations.push({
        hint: repairHints.adaptOriginal,
        message: `${path} creates replacement product UI instead of adapting the original application.`,
        path,
      });
    }
    if (isStandaloneReplacementRuntime(patch)) {
      violations.push({
        hint: repairHints.adaptOriginal,
        message: `${path} creates a standalone server with replacement product markup or styling.`,
        path,
      });
    }
    if (
      resolvedStartCommands.some((command) =>
        commandReferencesPath(command, path),
      )
    ) {
      violations.push({
        hint: repairHints.adaptOriginal,
        message: `The prepared start command launches newly created application entrypoint ${path}.`,
        path,
      });
    }
  }

  if (/^-.*["']workspaces["']/m.test(packagePatch.text)) {
    violations.push({
      hint: repairHints.keepWorkspaces,
      message:
        "package.json removes the original workspace configuration instead of adapting the original app.",
      path: "package.json",
    });
  }
  const narrowedBuildScope = readNarrowedBuildScope(
    input.preparationManifest.appDir,
    filePatches,
    input.repoSourceFiles,
  );
  if (narrowedBuildScope !== undefined) {
    violations.push(narrowedBuildScope);
  }
  for (const path of createdPaths) {
    if (!isDemoSeamPath(path) && packagePatch.addedText.includes(path)) {
      violations.push({
        hint: repairHints.adaptOriginal,
        message: `package.json redirects an application command to newly created file ${path}.`,
        path: "package.json",
      });
    }
  }

  return violations;
}

/**
 * Applies an adjudication agent's verdicts to the candidate vetoes with the
 * evidence bar the judge cannot lower: a confirmation stands only when every
 * quoted evidence line literally appears in the named file's diff section
 * (or anywhere in the patch for candidates without a file), and at least one
 * quote was given. Unjudged candidates always survive — the judge can only
 * rescue from false vetoes, never weaken the gate.
 */
export function reconcileFidelityAdjudication(input: {
  candidates: FidelityCandidate[];
  patch: string;
  verdicts: FidelityAdjudicationVerdict[];
}): {
  record: FidelityAdjudicationRecord;
  steering: string[];
  surviving: FidelityCandidate[];
} {
  const sections = parsePatchSections(input.patch);
  const surviving: FidelityCandidate[] = [];
  const steering: string[] = [];
  const outcomes = input.candidates.map((candidate, candidateIndex) => {
    const outcomeOf = (
      outcome: FidelityAdjudicationRecord["outcomes"][number]["outcome"],
    ) => ({ candidateIndex, message: candidate.message, outcome });
    const verdict = input.verdicts.find(
      (entry) => entry.candidateIndex === candidateIndex,
    );
    if (verdict === undefined) {
      surviving.push(candidate);
      return outcomeOf("unjudged");
    }
    if (verdict.verdict === "overturn") {
      return outcomeOf("overturned");
    }
    const evidenceText =
      candidate.path === undefined
        ? input.patch
        : (sections.get(candidate.path)?.text ?? "");
    const quotes = verdict.quotedEvidence
      .map((quote) => quote.trim())
      .filter((quote) => quote.length > 0);
    if (
      quotes.length === 0 ||
      !quotes.every((quote) => evidenceText.includes(quote))
    ) {
      return outcomeOf("overturned-unverifiable");
    }
    surviving.push(candidate);
    if (verdict.steering !== undefined && verdict.steering.trim().length > 0) {
      steering.push(verdict.steering);
    }
    return outcomeOf("confirmed");
  });
  return { record: { outcomes, status: "adjudicated" }, steering, surviving };
}

/**
 * Walks the shared gated-adaptation ladder: replacement presentation first,
 * then the demo-gate check, then unpreserved removals — computing each step's
 * evidence only when every earlier step passed.
 */
function readGatedAdaptationViolation(input: {
  addsPresentation: boolean;
  changedCallerGate: boolean;
  demoGate: DemoGateEvidence;
  kind: "authentication" | "integration" | "presentation";
  originalSource: string;
  patch: PatchSection;
  path: string;
}): FidelityViolation | undefined {
  if (input.addsPresentation) {
    return {
      hint: repairHints.preserveUi,
      message: `${input.path} modifies original product UI, styling, or brand assets instead of preserving them.`,
      path: input.path,
    };
  }
  const gateExempt = isGateExemptDataPath(input.path);
  if (!gateExempt && !input.changedCallerGate) {
    const gateViolation = readDemoAdaptationViolation(
      input.demoGate,
      input.path,
      input.patch,
      input.kind,
      input.originalSource,
    );
    if (gateViolation !== undefined) {
      return {
        hint: repairHints.gate,
        message: gateViolation,
        path: input.path,
      };
    }
  }
  const unpreserved = readUnpreservedRemovedLine(input.patch);
  if (unpreserved === undefined) {
    return undefined;
  }
  if (gateExempt) {
    return {
      hint: repairHints.preserveBehavior,
      message: `${input.path} removes original content (\`${unpreserved}\`); this file cannot carry the demo gate, so demo adaptations there must be additive.`,
      path: input.path,
    };
  }
  return {
    hint: repairHints.preserveBehavior,
    message:
      input.kind === "presentation"
        ? `${input.path} removes original presentation (\`${unpreserved}\`) instead of preserving it behind the demo gate.`
        : `${input.path} removes original ${input.kind} behavior (\`${unpreserved}\`) instead of preserving it behind the demo gate.`,
    path: input.path,
  };
}

/**
 * Data manifests such as package.json execute nothing, and TypeScript
 * declaration files are erased before runtime, so demanding a demo-gate
 * conditional inside them is structurally unsatisfiable steering; their demo
 * adaptations are held to the additive-only preservation rule instead.
 * Stylesheets and markup stay in the strict lane: they also cannot carry a
 * conditional, but their correct demo adaptation is a gated wrap at the
 * source level, never an ungated presentation edit.
 */
function isGateExemptDataPath(path: string) {
  return /\.(?:json[5c]?|d\.[cm]?ts)$/i.test(path);
}

function readInvalidRepairPaths(input: {
  dependencyRepair?: boolean;
  repairBaseline?: PreparationWorkspaceDiff;
  workspaceDiff: PreparationWorkspaceDiff;
}): Set<string> {
  const baseline = input.repairBaseline;
  if (baseline === undefined || input.dependencyRepair !== true) {
    return new Set();
  }
  return new Set(
    readDependencyRepairDelta(
      baseline,
      input.workspaceDiff,
    ).changedPaths.filter(
      (path) =>
        !isDependencyRepairInputPath(path) &&
        !isPackageManagerLockfilePath(path),
    ),
  );
}

function isDependencyRepairInputPath(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return name === "package.json" || dependencyConfigurationNames.has(name);
}

export function isPackageManagerLockfilePath(path: string): boolean {
  return lockfileNames.has(path.split("/").at(-1) ?? path);
}

/**
 * Builds the preparation-fidelity report from the surviving candidates,
 * carrying the adjudication record (when a judge ran) and any judge
 * steering so repairs are told what to change, not just that a rule fired.
 */
export function createPreparationFidelityReport(input: {
  adjudication?: FidelityAdjudicationRecord;
  candidates: FidelityCandidate[];
  steering?: string[];
}): ValidationReport {
  const violations = input.candidates;
  const passed = violations.length === 0;
  return {
    artifactReferences: [
      "/workspace/.makeademo/preparation-workspace-diff.json",
      "/workspace/.makeademo/preparation-manifest.json",
    ],
    blockedNetworkAttempts: [],
    browserObservations: [],
    consoleErrors: [],
    ...(passed ? {} : { failureClassification: "product fidelity violation" }),
    ...(input.adjudication === undefined
      ? {}
      : { fidelityAdjudication: input.adjudication }),
    logsSummary: passed
      ? "Prepared runtime preserves the screened product application."
      : `Prepared runtime does not preserve the screened product: ${violations
          .map((violation) => violation.message)
          .join(" ")}`,
    networkAttempts: [],
    pageErrors: [],
    retryCount: 0,
    screenshots: [],
    stage: "preparation-fidelity",
    status: passed ? "passed" : "failed",
    stderrExcerpts: [],
    stdoutExcerpts: [],
    suggestedRepairHints: [
      ...new Set([
        ...violations.map((violation) => violation.hint),
        ...(input.steering ?? []),
      ]),
    ],
  };
}

function isStandaloneReplacementRuntime(patch: PatchSection) {
  const additions = patch.addedText;
  return (
    /\b(?:Bun\.serve|createServer|serve)\s*\(/.test(additions) &&
    /(?:<!doctype\s+html|<html\b|<style\b|style\s*=)/i.test(additions)
  );
}

function addsServerSelfRequest(
  path: string,
  patch: PatchSection,
  baseUrl: string,
) {
  if (!isServerExecutionPath(path)) return false;
  const additions = patch.addedText;
  if (
    !/\b(?:axios|fetch|got|httpBatchLink|httpLink|request|superagent|urllib)\b/i.test(
      additions,
    )
  ) {
    return false;
  }
  const url = new URL(baseUrl);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const ownListenerPattern = `https?:\\/\\/(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|localhost|\\[?::1\\]?):${escapeRegExp(port)}(?:[/\\s'\"\`]|$)`;
  return new RegExp(ownListenerPattern, "i").test(additions);
}

function isServerExecutionPath(path: string) {
  return /(?:^|\/)(?:api|backend|rpc|server|trpc)(?:\/|$)|(?:^|[._-])server\.[^/]+$/i.test(
    path,
  );
}

/**
 * Added lines whose content already exists in the original file are ignored:
 * a demo-gate wrap re-adds the line it wraps, and re-introduced original
 * markup is preservation, not new authorship.
 */
function addsProductPresentation(patch: PatchSection, originalSource = "") {
  const additions = patch.added
    .filter((line) => !originalSource.includes(line.trim()))
    .join("\n");
  return (
    /<!doctype\s+html|<(?:a|article|aside|body|button|canvas|dialog|div|footer|form|h[1-6]|header|html|img|input|label|li|main|nav|ol|p|section|select|span|style|svg|table|textarea|ul|video)\b/i.test(
      additions,
    ) ||
    /(?:return\s*\(?|=>\s*\(?)\s*<\/?[A-Z]/.test(additions) ||
    /^\s*<\/?[A-Z][A-Za-z0-9.]*\b[^>]*>/m.test(additions) ||
    /\b(?:className|dangerouslySetInnerHTML|style)\s*=/.test(additions)
  );
}

function onlyLocalizesExternalAssets(patch: PatchSection) {
  const removed = patch.removed;
  const added = patch.added;
  return (
    removed.length > 0 &&
    removed.length === added.length &&
    removed.every((before, index) => {
      const after = added[index] ?? "";
      const external =
        /(["'])((?:https?:)?\/\/[^"']+)\1/.exec(before)?.[2] ??
        /url\(\s*((?:https?:)?\/\/[^)\s"']+)\s*\)/i.exec(before)?.[1];
      const local =
        /(["'])((?:\.?\.\/|\/)[^"']+\.[a-z0-9]+(?:[?#][^"']*)?)\1/i.exec(
          after,
        )?.[2] ??
        /url\(\s*((?:\.?\.\/|\/)[^)\s"']+\.[a-z0-9]+)\s*\)/i.exec(after)?.[1];
      return (
        external !== undefined &&
        local !== undefined &&
        before.replace(external, "__ASSET__") ===
          after.replace(local, "__ASSET__")
      );
    })
  );
}

function isProductPresentationPath(path: string) {
  return (
    /\.(?:css|html|jsx|less|png|jpe?g|scss|svg|svelte|tsx|vue|webp)$/i.test(
      path,
    ) ||
    /(?:^|\/)(?:app|components|pages|routes|screens|views)(?:\/|$)/i.test(path)
  );
}

/**
 * File types that are presentation by nature: creating one authors UI
 * regardless of what the diff shows. Deliberately excludes .jsx/.tsx —
 * script files whose content may be a one-line gate; for them the content
 * check decides.
 */
function isPresentationByFileType(path: string) {
  return /\.(?:css|html|less|png|jpe?g|scss|svg|svelte|vue|webp)$/i.test(path);
}

function isDemoSeamPath(path: string) {
  // The `demo` clause is an owned convention, not vocabulary: the pipeline's
  // own prompts direct agents to build demo-gated adaptations under
  // demo-named files, and casing must not matter (outline's camelCase
  // demoFixtures.ts missed every delimiter-bound token, 2026-08-09).
  return (
    /(?:^|[./_-])(?:adapters?|api|auth|caches?|clients?|configs?|data|databases?|db|env|fixtures?|gateways?|graphql|integrations?|middleware|mocks?|providers?|proxy|repositor(?:y|ies)|rpc|seeds?|services?|sessions?|stores?|trpc)(?:[./_-]|$)/i.test(
      path,
    ) || /demo/i.test(path)
  );
}

interface DemoGateEvidence {
  flags: string[];
  identifiers: string[];
}

/**
 * Matches any spelling of the pipeline-owned gate token — prefixed
 * (`VITE_`, `NEXT_PUBLIC_`), define-wrapped (`__MAKEADEMO_DEMO__`), or
 * bare. Substring by design: the delimiter-bound variant rejected the
 * Vite-required prefix and killed excalidraw's canonical repair (2026-08-09).
 */
const gateTokenPattern = /makeademo_demo/i;

function readConfiguredDemoFlags(
  preparationManifest: PreparationManifest,
): string[] {
  return Object.entries(preparationManifest.envUsed)
    .filter(
      ([key, value]) =>
        /(?:^|_)MAKEADEMO_DEMO$/i.test(key) && /^(?:1|true)$/i.test(value),
    )
    .map(([key]) => key);
}

function declaresMissingStubMechanism(detail: string): boolean {
  return /\b(?:no|without(?:\s+an?)?)\s+(?:(?:local|demo|fixture[- ]backed)\s+)?(?:fixture(?:\s+adapter)?|mock|stub|adapter|delivery\s+mechanism)\b[^.!;\n]{0,50}\b(?:added|created|implemented|provided|wired)\b/i.test(
    detail,
  );
}

function readDemoGateEvidence(
  preparationManifest: PreparationManifest,
  repoSourceFiles: ReadonlyMap<string, string | undefined>,
  workspaceDiff: PreparationWorkspaceDiff,
  filePatches: ReadonlyMap<string, PatchSection>,
): DemoGateEvidence {
  const configuredFlags = readConfiguredDemoFlags(preparationManifest);
  if (configuredFlags.length === 0) {
    return { flags: [], identifiers: [] };
  }
  const sources = [
    ...[...repoSourceFiles]
      .filter(
        ([path, source]) =>
          source !== undefined && isExecutableSourcePath(path),
      )
      .map(([path, source]) => ({ code: source ?? "", path })),
    ...workspaceDiff.changedPaths
      .map(toRepoRelativePath)
      .filter(isExecutableSourcePath)
      .map((path) => ({ code: filePatches.get(path)?.addedText ?? "", path })),
  ];
  // Any genuine read of the gate token — under any prefixed spelling —
  // validates every configured flag: the code owns the semantic, and
  // demanding envUsed spell each prefixed variant is the treadmill this
  // design retires. The AST decides what counts as a read (a bare string
  // literal does not); the env-shaped textual fallback covers non-JS
  // sources and commented-out reads the parser treats as trivia.
  const evidence = sources.map(({ code, path }) => ({
    analysis: gateTokenPattern.test(code)
      ? analyzeDemoGateUsage({ fileName: path, source: code })
      : undefined,
    code,
  }));
  const flagsRead = evidence.some(
    ({ analysis, code }) =>
      (analysis?.gateNames.length ?? 0) > 0 || readsDemoFlagText(code),
  );
  return {
    flags: flagsRead ? configuredFlags : [],
    identifiers: [
      ...new Set(
        evidence.flatMap(({ analysis }) => analysis?.gateBindings ?? []),
      ),
    ],
  };
}

/**
 * Env-read-shaped textual mention of the gate token: an env/config accessor
 * within reach of any spelling containing MAKEADEMO_DEMO. Deliberately
 * front-unrestricted so prefixed spellings count; a bare string literal
 * without an accessor shape does not.
 */
function readsDemoFlagText(code: string): boolean {
  return /(?:\$\{?|(?:config|env(?:ironment)?|getenv|settings)\b[\s\S]{0,80})[A-Za-z0-9_]*MAKEADEMO_DEMO/i.test(
    code,
  );
}

function readDemoAdaptationViolation(
  demoGate: DemoGateEvidence,
  path: string,
  patch: PatchSection,
  kind: "authentication" | "integration" | "presentation",
  originalSource: string,
): string | undefined {
  if (demoGate.flags.length === 0) {
    return missingDemoGateViolation(path, kind);
  }
  if (!hasConditionalDemoGate(path, patch, demoGate, originalSource)) {
    return `${path} does not conditionally use the repository's active MakeADemo demo gate for the ${kind} adaptation.`;
  }
  return undefined;
}

/**
 * Returns the first removed line whose content is not recoverable from the
 * additions. A gated adaptation must wrap original behavior, not delete it:
 * every removed non-blank line must survive verbatim or token-by-token (the
 * token fallback tolerates gate wrapping such as inline ternaries). C-style
 * comment lines are exempt unless they carry a tool directive: comments hold
 * no product behavior, and two matrix runs lost a correct repair candidate to
 * a dropped comment alone.
 */
function readUnpreservedRemovedLine(patch: PatchSection): string | undefined {
  const additions = patch.addedText;
  for (const removed of patch.removed) {
    const line = removed.trim();
    if (line.length < 3 || /^[{}()[\]<>/*,;`'"\\|&-]*$/.test(line)) continue;
    if (isNonDirectiveCommentLine(line)) continue;
    if (additions.includes(line)) continue;
    const tokens = line.match(/[A-Za-z0-9_$"'`./-]{3,}/g) ?? [];
    if (tokens.length === 0) continue;
    if (tokens.every((token) => additions.includes(token))) continue;
    return line.length > 80 ? `${line.slice(0, 80)}…` : line;
  }
  return undefined;
}

/**
 * A trimmed removed line is an ignorable comment when it is a whole-line
 * C-style comment (`//`, `/*`, JSDoc `*` continuation, or a JSX-wrapped
 * block comment) that carries no tool directive. Directive comments such as
 * eslint/biome/prettier suppressions or `@ts-*` markers change build or lint
 * behavior, so removing them still counts as an unpreserved removal. Hash
 * comments are deliberately not exempt: `#` also opens JavaScript private
 * fields, and no run has been lost to a removed hash comment.
 */
function isNonDirectiveCommentLine(line: string): boolean {
  return (
    (/^\/\//.test(line) ||
      /^\{?\/\*/.test(line) ||
      /^\*(?:\s|\/|$)/.test(line)) &&
    !/\b(?:eslint|biome-ignore|prettier-ignore|istanbul|@ts-|@vite-ignore|@jsx|webpack[A-Z])/.test(
      line,
    )
  );
}

function isAuthenticationAdaptation(path: string, patch: PatchSection) {
  return (
    isExecutableSourcePath(path) &&
    (containsAuthenticationTerms(patch.text) ||
      /(?:^|[./_-])(?:auth|identity|login|oauth|principal|session)(?:[./_-]|$)/i.test(
        path,
      ))
  );
}

function isIntegrationAdaptation(path: string, patch: PatchSection) {
  return (
    isExecutableSourcePath(path) &&
    (isDemoSeamPath(path) || containsIntegrationTerms(patch.text))
  );
}

function containsAuthenticationTerms(source: string) {
  return /\b(?:auth(?:entication|orization)?|claims?|credentials?|current\s+users?|identity|login|logout|oauth|principal|redirect|sessions?|sign\s+(?:in|out))\b/i.test(
    normalizedWords(source),
  );
}

function containsIntegrationTerms(source: string) {
  return /\b(?:api|caches?|clients?|data\s+sources?|databases?|fixtures?|gateways?|graphql|mocks?|repositor(?:y|ies)|rpc|services?)\b/i.test(
    normalizedWords(source),
  );
}

function normalizedWords(source: string) {
  return source.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_$-]+/g, " ");
}

function missingDemoGateViolation(
  path: string,
  kind: "authentication" | "integration" | "presentation",
) {
  return `${path} changes ${kind} behavior without an active MakeADemo demo flag recorded in envUsed.`;
}

/**
 * Answers "do this patch's additions conditionally use the demo gate?" with
 * an AST, not a regex window. The gate may appear as any spelling of the
 * pipeline-owned token, a binding derived from it in this file's scope, or a
 * repo-wide gate identifier this file imports or declares. Non-JS-family and
 * unextractable sources fail open: "no gate found" without a parse must
 * never veto (N92) — the adjudicating judge still reviews the candidate.
 */
function hasConditionalDemoGate(
  path: string,
  patch: PatchSection,
  demoGate: DemoGateEvidence,
  originalSource: string,
) {
  const additions = patch.addedText;
  const fileScope = `${originalSource}\n${additions}`;
  const scopeProbe = analyzeDemoGateUsage({
    fileName: path,
    source: fileScope,
  });
  if (scopeProbe === undefined) {
    return true;
  }
  const importedGateIdentifiers = demoGate.identifiers.filter((identifier) =>
    scopeProbe.boundNames.includes(identifier),
  );
  const scopeAnalysis =
    analyzeDemoGateUsage({
      fileName: path,
      knownGateIdentifiers: importedGateIdentifiers,
      source: fileScope,
    }) ?? scopeProbe;
  const additionsAnalysis = analyzeDemoGateUsage({
    fileName: path,
    knownGateIdentifiers: [
      ...new Set([...importedGateIdentifiers, ...scopeAnalysis.gateBindings]),
    ],
    source: additions,
  });
  return additionsAnalysis?.hasConditionalGate ?? true;
}

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(?:^|(?<=\s))(?:\/\/|#).*$/gm, " ");
}

function isExecutableSourcePath(path: string) {
  return /\.(?:cjs|cs|go|java|js|jsx|mjs|mts|php|py|rb|rs|sh|svelte|ts|tsx|vue)$/i.test(
    path,
  );
}

function isVendoredAssetPath(path: string) {
  return (
    /(?:^|\/)(?:assets|fonts|images|public|static|vendor)(?:\/|$)/i.test(
      path,
    ) &&
    /\.(?:avif|eot|gif|ico|jpe?g|mp3|mp4|ogg|otf|png|svg|ttf|wav|webm|webp|woff2?)$/i.test(
      path,
    )
  );
}

function commandReferencesPath(command: string, path: string) {
  return command.split(/\s+/).some((token) => token === path);
}

/**
 * Resolves a package-manager start command one level through the script table
 * so a created entrypoint cannot hide behind `npm run <script>`. Reads both
 * the original package.json and script lines added by the preparation patch.
 */
function readResolvedStartCommands(
  startCommandUsed: string,
  repoSourceFiles: ReadonlyMap<string, string | undefined>,
  packageAdditions: string,
): string[] {
  const commands = [startCommandUsed];
  const scriptName =
    /^\s*(?:corepack\s+)?(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/.exec(
      startCommandUsed,
    )?.[1];
  if (scriptName === undefined) return commands;
  const sources = [repoSourceFiles.get("package.json") ?? "", packageAdditions];
  for (const source of sources) {
    const script = new RegExp(
      `"${escapeRegExp(scriptName)}"\\s*:\\s*"([^"]+)"`,
    ).exec(source)?.[1];
    if (script !== undefined) commands.push(script);
  }
  return commands;
}

// Explicit workspace-target selectors inside a build script body: an nx
// task target, a filter/scope/project flag (turbo, pnpm, lerna, nx), a yarn
// `workspace <name>` subcommand, or an npm `-w`/`--workspace` flag. These
// are the shapes that make a build script build some OTHER package.
const buildSelectorPatterns = [
  /\bnx\s+(?:build|run|serve)\s+([\w@./:-]+)/g,
  /--(?:filter|scope|projects?)[=\s]+([^\s'"]+)/g,
  /\bworkspace\s+([\w@./-]+)/g,
  /(?:^|\s)(?:-w|--workspace)[=\s]([^\s'"]+)/g,
];

function readBuildSelectorTargets(segment: string): string[] {
  return buildSelectorPatterns.flatMap((pattern) =>
    [...segment.matchAll(pattern)].flatMap((match) => {
      const target = (match[1] ?? "").split(":")[0] ?? "";
      return target === "" ? [] : [target];
    }),
  );
}

/**
 * Detects a repair buying a green build gate by narrowing the build's scope:
 * the selected app package's own `build` script rewritten so that every step
 * is redirected at a different workspace package (twenty round 6 rewrote it
 * to `npx nx build twenty-shared`, which exits 0 by no longer building the
 * app, 2026-08-13). Fires only when the patch changes the script, every
 * command segment carries an explicit workspace-target selector, and none of
 * the targets reference the app by package name or directory — a script that
 * keeps any in-place step or names the app is the legitimate shape of the
 * same edit, and adjudication can rescue task runners whose project names
 * match none of the app's identifiers.
 */
function readNarrowedBuildScope(
  appDir: string,
  filePatches: ReadonlyMap<string, PatchSection>,
  repoSourceFiles: ReadonlyMap<string, string | undefined>,
): FidelityViolation | undefined {
  const normalizedAppDir = appDir.replace(/^\.\/?/, "").replace(/\/$/, "");
  const packagePath =
    normalizedAppDir === ""
      ? "package.json"
      : `${normalizedAppDir}/package.json`;
  const patch = filePatches.get(packagePath);
  if (patch === undefined) return undefined;
  const readBuildScript = (lines: string[]) =>
    lines
      .map((line) => /"build"\s*:\s*"([^"]+)"/.exec(line)?.[1])
      .find((body) => body !== undefined);
  const rewrittenBuild = readBuildScript(patch.added);
  if (rewrittenBuild === undefined) return undefined;
  const originalSource = repoSourceFiles.get(packagePath) ?? "";
  const originalBuild =
    /"build"\s*:\s*"([^"]+)"/.exec(originalSource)?.[1] ??
    readBuildScript(patch.removed);
  if (rewrittenBuild === originalBuild) return undefined;
  const packageName = /"name"\s*:\s*"([^"]+)"/.exec(originalSource)?.[1];
  const appTokens = new Set(
    [
      packageName,
      packageName?.split("/").at(-1),
      normalizedAppDir,
      normalizedAppDir.split("/").at(-1),
    ]
      .filter((token): token is string => token !== undefined && token !== "")
      .map((token) => token.toLowerCase()),
  );
  const referencesApp = (target: string) => {
    const cleaned = target
      .toLowerCase()
      .replace(/^\.\//, "")
      .replace(/\.{3}$/, "");
    return (
      appTokens.has(cleaned) || appTokens.has(cleaned.split("/").at(-1) ?? "")
    );
  };
  const segments = rewrittenBuild
    .split(/&&|\|\||;/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  const segmentTargets = segments.map(readBuildSelectorTargets);
  if (
    segments.length === 0 ||
    segmentTargets.some((targets) => targets.length === 0)
  ) {
    return undefined;
  }
  const targets = [...new Set(segmentTargets.flat())];
  if (targets.some(referencesApp)) return undefined;
  return {
    hint: repairHints.buildAppUnderTest,
    message: `${packagePath} rewrites the selected app's "build" script to "${rewrittenBuild}", which builds only ${targets.join(
      ", ",
    )} and never references the app under test (${
      packageName ?? (normalizedAppDir === "" ? packagePath : normalizedAppDir)
    }); the build gate would pass without building the app.`,
    path: packagePath,
  };
}

/**
 * One file's slice of the preparation diff, with its added and removed lines
 * (prefixes stripped) split out once so fidelity checks never re-scan the raw
 * section per check.
 */
type PatchSection = {
  added: string[];
  addedText: string;
  removed: string[];
  text: string;
};

const emptyPatchSection: PatchSection = {
  added: [],
  addedText: "",
  removed: [],
  text: "",
};

/**
 * Splits a unified diff into per-file sections in one pass. Section headers
 * match only at line starts, so header-shaped text inside added or removed
 * content cannot open a section. Renamed files register under both paths.
 */
function parsePatchSections(patch: string): Map<string, PatchSection> {
  const sections = new Map<string, string>();
  const lines = patch.split("\n");
  let start = -1;
  let paths: string[] = [];
  const flush = (end: number) => {
    if (start === -1) return;
    const section = lines.slice(start, end).join("\n");
    for (const path of paths) {
      const existing = sections.get(path);
      sections.set(
        path,
        existing === undefined ? section : `${existing}\n${section}`,
      );
    }
  };
  for (const [index, line] of lines.entries()) {
    const header =
      /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+?)"|b\/(.+))$/.exec(line);
    if (header === null) continue;
    flush(index);
    start = index;
    paths = [
      ...new Set(
        [header[1] ?? header[2], header[3] ?? header[4]].filter(
          (path): path is string => path !== undefined,
        ),
      ),
    ];
  }
  flush(lines.length);
  return new Map(
    [...sections].map(([path, text]) => [path, createPatchSection(text)]),
  );
}

/**
 * Returns the named file's slice of a unified diff, or undefined when the
 * diff carries no section for that path. Callers that present one candidate's
 * evidence (such as the fidelity adjudication prompt) use this to show the
 * flagged file's own changes instead of the whole preparation patch.
 */
export function readPatchSectionText(
  patch: string,
  path: string,
): string | undefined {
  return parsePatchSections(patch).get(path)?.text;
}

function createPatchSection(text: string): PatchSection {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed.push(line.slice(1));
    }
  }
  return { added, addedText: added.join("\n"), removed, text };
}

function isFrameworkConfigPath(path: string) {
  const name = path.split("/").at(-1) ?? path;
  return (
    /^[^/]*\.config\.[cm]?[jt]sx?$/i.test(name) ||
    /^tsconfig[^/]*\.json$/i.test(name) ||
    name === ".env.example"
  );
}

function toRepoRelativePath(path: string) {
  return path.replace(/^\/workspace\/repo\//, "").replace(/^\.\//, "");
}
