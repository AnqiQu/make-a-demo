import { provisionableServices } from "../sandbox-services/sandbox-services";
import type {
  DataStrategyRung,
  PreparationManifest,
  RepoProfile,
  RunPlan,
} from "../schemas/artifacts";
import { findRoutePlaceholder } from "../tools/route-placeholders";

const templateValuePattern = /^replace-with-/i;

/**
 * Verifies that Repo Preparation produced source-backed, browser-addressable
 * product context and prepared every maker-requested feature exactly once.
 */
export function assertPreparedFeatureInventory(input: {
  demoBrief: { keyProductFeatures?: string[] };
  preparationManifest: PreparationManifest;
  repoProfile?: RepoProfile;
  repoSourcePaths: ReadonlySet<string>;
  runPlan?: RunPlan;
}): void {
  const context = input.preparationManifest.productContext;
  assertPreparationRuntimeTarget(input);
  if (
    templateValuePattern.test(context.name) ||
    templateValuePattern.test(context.summary)
  ) {
    throw new Error(
      "PreparationManifest productContext must replace template product values",
    );
  }
  if (context.evidencePaths.length === 0) {
    throw new Error(
      "PreparationManifest productContext.evidencePaths must contain source evidence",
    );
  }
  const unknownSourcePaths = collectUnknownSourcePaths(
    context.evidencePaths,
    input.repoSourcePaths,
    "productContext.evidencePaths",
  );
  if (context.featureInventory.length === 0) {
    throw new Error(
      "PreparationManifest productContext.featureInventory must contain at least one demo feature",
    );
  }
  for (const [index, feature] of context.featureInventory.entries()) {
    unknownSourcePaths.push(
      ...collectUnknownSourcePaths(
        feature.sourcePaths,
        input.repoSourcePaths,
        `productContext.featureInventory[${index}].sourcePaths`,
      ),
    );
  }
  // One error names every offending citation (repair-evidence contract
  // clause 4): reporting them one at a time made the 2026-08-08 midday
  // repair whack-a-mole — the same created-file path was rejected from a
  // different field on every round.
  if (unknownSourcePaths.length > 0) {
    throw new Error(
      `PreparationManifest cites paths outside the screened repository: ${unknownSourcePaths.join(
        "; ",
      )}. Product evidence must cite files that exist in the original screened repository — files added during preparation (fixtures, demo gates, mock endpoints) are never product evidence; cite the original modules the demo adapts instead.`,
    );
  }
  // One error names every pattern route (repair-evidence contract clause 4):
  // the 2026-08-08 outline demo opened on /collection/:collectionSlug — a
  // router pattern navigated verbatim is a guaranteed 404.
  const placeholderEntryPaths = context.featureInventory.flatMap(
    (feature, index) =>
      feature.entryPaths.flatMap((entryPath, entryIndex) =>
        findRoutePlaceholder(entryPath) === undefined
          ? []
          : [
              `productContext.featureInventory[${index}].entryPaths[${entryIndex}] ${entryPath}`,
            ],
      ),
  );
  if (placeholderEntryPaths.length > 0) {
    throw new Error(
      `PreparationManifest declares router patterns as demo routes: ${placeholderEntryPaths.join(
        "; ",
      )}. Demo routes must be concrete URLs reachable in the prepared app — substitute the fixture slugs your preparation created (for example /collection/demo-collection, never /collection/:collectionSlug).`,
    );
  }
  for (const [index, feature] of context.featureInventory.entries()) {
    const path = `productContext.featureInventory[${index}]`;
    if (
      templateValuePattern.test(feature.id) ||
      templateValuePattern.test(feature.description)
    ) {
      throw new Error(`${path} must replace template feature values`);
    }
    if (feature.sourcePaths.length === 0) {
      throw new Error(`${path}.sourcePaths must contain source evidence`);
    }
    if (!feature.sourcePaths.some(isBrowserUiSourcePath)) {
      throw new Error(
        `${path}.sourcePaths must cite an original route, page, component, or browser UI module`,
      );
    }
    if (feature.entryPaths.length === 0) {
      throw new Error(`${path}.entryPaths must contain a local app path`);
    }
  }
  if (
    context.featureInventory.some(
      ({ authStrategy }) => authStrategy !== "none",
    ) &&
    input.preparationManifest.authBypassOrDemoIdentity === undefined
  ) {
    throw new Error(
      "PreparationManifest.authBypassOrDemoIdentity must describe the active off-camera authentication bootstrap",
    );
  }
  assertDeclaredProofs(context.featureInventory);
  assertDataStrategyCoverage(
    input.preparationManifest,
    input.repoProfile?.servicesRequired ?? [],
  );

  const requestedFeatures = input.demoBrief.keyProductFeatures ?? [];
  if (requestedFeatures.length === 0) {
    return;
  }
  const preparedRequestedFeatures = context.featureInventory.flatMap(
    (feature) =>
      feature.requestedFeature === undefined ? [] : [feature.requestedFeature],
  );
  for (const prepared of preparedRequestedFeatures) {
    if (requestedFeatures.includes(prepared)) continue;
    const exact = requestedFeatures.find(
      (requested) => normalizeFeature(requested) === normalizeFeature(prepared),
    );
    if (exact !== undefined) {
      throw new Error(
        `PreparationManifest must preserve exact requested feature text: write "${exact}", not "${prepared}".`,
      );
    }
  }
  const requested = countNormalizedFeatures(requestedFeatures);
  const prepared = countNormalizedFeatures(preparedRequestedFeatures);
  const missing = readFeatureCountDifference(requested, prepared);
  const unexpected = readFeatureCountDifference(prepared, requested);
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      [
        "PreparationManifest must prepare every requested demo feature exactly once.",
        ...(missing.length === 0 ? [] : [`Missing: ${missing.join(", ")}.`]),
        ...(unexpected.length === 0
          ? []
          : [`Unexpected: ${unexpected.join(", ")}.`]),
      ].join(" "),
    );
  }
  // N107: the declaration is required for maker-requested features, checked
  // only after the feature set itself is right — prepare the right
  // features, then declare each one's proof.
  const missingProofs = context.featureInventory.flatMap((feature, index) =>
    feature.requestedFeature === undefined ||
    feature.expectedProof !== undefined
      ? []
      : [`productContext.featureInventory[${index}] ${feature.id}`],
  );
  if (missingProofs.length > 0) {
    throw new Error(
      `PreparationManifest maker-requested features must declare expectedProof: ${missingProofs.join(
        "; ",
      )}. Declare the typed browser-checkable outcome that proves each feature on its entry route — visible-text (an exact on-screen string), element-appears (a visible element's accessible name), state-transition (click the control named locator while its state reads from and observe state to), app-state (the value the app persists under key in local-storage or session-storage contains the substring contains; preferred for canvas features), or canvas-delta (clicking the control named locator visibly changes the canvas pixels; weakest acceptable).`,
    );
  }
}

// Accessible names never start with selector sigils or route slashes and
// never carry markup or attribute-selector syntax.
const selectorShapedPattern = /^[.#/]|[<>]|\[[a-z-]+[=\]]/i;

/**
 * Verifies every declared proof is executable and distinguishing: template
 * values replaced, locators in accessible-name space, transitions starting
 * from an exercisable state, and no two features sharing one proof.
 */
function assertDeclaredProofs(
  featureInventory: PreparationManifest["productContext"]["featureInventory"],
): void {
  const declared = featureInventory.flatMap((feature, index) =>
    feature.expectedProof === undefined
      ? []
      : [
          {
            path: `productContext.featureInventory[${index}]`,
            proof: feature.expectedProof,
          },
        ],
  );
  const templateProofs = declared.flatMap(({ path, proof }) =>
    Object.values(proof).some((value) => templateValuePattern.test(value))
      ? [`${path}.expectedProof`]
      : [],
  );
  if (templateProofs.length > 0) {
    throw new Error(
      `PreparationManifest declared proofs must replace template values: ${templateProofs.join(
        "; ",
      )}. Write the real on-screen outcome the prepared app shows.`,
    );
  }
  const disabledStarts = declared.flatMap(({ path, proof }) =>
    proof.kind === "state-transition" && /^disabled$/i.test(proof.from)
      ? [`${path}.expectedProof`]
      : [],
  );
  if (disabledStarts.length > 0) {
    throw new Error(
      `PreparationManifest state-transition proofs must not start from disabled: ${disabledStarts.join(
        "; ",
      )}. A disabled control cannot be clicked — seed fixture state so the control starts enabled (history pre-populated so Undo is clickable, a followable author whose control will rename).`,
    );
  }
  const selectorShaped = declared.flatMap(({ path, proof }) => {
    // app-state values are the app's own storage key and stored substring,
    // not accessible names, so the selector-shape rule never applies (N157).
    const locatorValues =
      proof.kind === "visible-text" || proof.kind === "app-state"
        ? []
        : proof.kind === "element-appears"
          ? [proof.name]
          : proof.kind === "canvas-delta"
            ? [proof.locator]
            : [proof.locator, proof.from, proof.to];
    return locatorValues.some((value) => selectorShapedPattern.test(value))
      ? [`${path}.expectedProof`]
      : [];
  });
  if (selectorShaped.length > 0) {
    throw new Error(
      `PreparationManifest declared proofs must use accessible names, never CSS selectors or XPath: ${selectorShaped.join(
        "; ",
      )}. Name the control or element exactly as its on-screen accessible name reads.`,
    );
  }
  const byProofKey = new Map<string, string[]>();
  for (const { path, proof } of declared) {
    const key = JSON.stringify(
      Object.fromEntries(Object.entries(proof).sort()),
    );
    byProofKey.set(key, [...(byProofKey.get(key) ?? []), path]);
  }
  const duplicated = [...byProofKey.values()].filter(
    (paths) => paths.length > 1,
  );
  if (duplicated.length > 0) {
    throw new Error(
      `PreparationManifest features declare identical proofs and cannot be distinguished: ${duplicated
        .map((paths) => paths.join(" and "))
        .join(
          "; ",
        )}. Each feature's proof must name evidence only that feature produces.`,
    );
  }
}

/**
 * The rungs of the data-backend ladder the backend can actually stand
 * behind today, in ladder preference order. provider-recipe (N122 sub-item
 * 6) joins this list when its per-provider recipes land — until then a
 * manifest choosing it would pass validation and then fail every runtime
 * round, so the rejection points at the rungs that work now.
 */
const backedDataStrategyRungs: DataStrategyRung[] = [
  "embedded-config",
  "provisioned-service",
  "client-stub",
  "declared-stub",
];

/**
 * The enforcement half of the data-backend ladder's closed loop (N122):
 * detection filled `servicesRequired`; preparation is not complete until
 * every detected service is answered by exactly one dataStrategy entry on
 * a rung the backend provides. Rejections carry the service, its evidence,
 * and the available rungs so the repair states the fix — and a service the
 * app can run without is still answered here (declared-stub with the
 * reason), never silently dropped.
 */
function assertDataStrategyCoverage(
  manifest: PreparationManifest,
  servicesRequired: NonNullable<RepoProfile["servicesRequired"]>,
): void {
  const declarations = manifest.dataStrategy ?? [];
  const templateDetails = declarations.flatMap((declaration, index) =>
    templateValuePattern.test(declaration.detail)
      ? [`dataStrategy[${index}]`]
      : [],
  );
  if (templateDetails.length > 0) {
    throw new Error(
      `PreparationManifest ${templateDetails.join(
        "; ",
      )} must replace template detail values with what was actually done for the service.`,
    );
  }
  const unbackedRungs = declarations.flatMap((declaration, index) =>
    backedDataStrategyRungs.includes(declaration.rung)
      ? []
      : [`dataStrategy[${index}] rung ${declaration.rung}`],
  );
  if (unbackedRungs.length > 0) {
    throw new Error(
      `PreparationManifest ${unbackedRungs.join(
        "; ",
      )} is not yet provided by the backend. Choose among: ${backedDataStrategyRungs.join(
        ", ",
      )}.`,
    );
  }
  const unprovisionable = declarations.flatMap((declaration, index) =>
    declaration.rung === "provisioned-service" &&
    !(provisionableServices as readonly string[]).includes(
      declaration.service.trim().toLowerCase(),
    )
      ? [`dataStrategy[${index}] provisions ${declaration.service}`]
      : [],
  );
  if (unprovisionable.length > 0) {
    throw new Error(
      `PreparationManifest ${unprovisionable.join(
        "; ",
      )}, but the sandbox can only provision: ${provisionableServices.join(
        ", ",
      )}. Choose another rung for this service.`,
    );
  }
  const strayCommands = declarations.flatMap((declaration, index) =>
    declaration.rung !== "provisioned-service" &&
    (declaration.migrationCommand !== undefined ||
      declaration.seedCommand !== undefined)
      ? [`dataStrategy[${index}] (rung ${declaration.rung})`]
      : [],
  );
  if (strayCommands.length > 0) {
    throw new Error(
      `PreparationManifest ${strayCommands.join(
        "; ",
      )} declares migrationCommand or seedCommand, which the harness executes only on the provisioned-service rung. Remove the commands or move the service to provisioned-service.`,
    );
  }
  const declaredServiceCounts = new Map<string, number>();
  for (const declaration of declarations) {
    const service = normalizeFeature(declaration.service);
    declaredServiceCounts.set(
      service,
      (declaredServiceCounts.get(service) ?? 0) + 1,
    );
  }
  const duplicated = [...declaredServiceCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([service]) => service);
  if (duplicated.length > 0) {
    throw new Error(
      `PreparationManifest.dataStrategy declares ${duplicated.join(
        ", ",
      )} more than once; declare exactly one entry per service.`,
    );
  }
  const unanswered = servicesRequired.filter(
    ({ service }) => !declaredServiceCounts.has(normalizeFeature(service)),
  );
  if (unanswered.length > 0) {
    throw new Error(
      `PreparationManifest.dataStrategy must answer every detected data service: ${unanswered
        .map(
          ({ evidencePaths, service }) =>
            `${service} (evidence: ${evidencePaths.join(", ")})`,
        )
        .join(
          "; ",
        )}. Declare one entry per service choosing a rung — embedded-config (preferred when the repo supports an embedded driver such as sqlite), client-stub (serve deterministic fixtures from the app's own fetch/API-client layer), or declared-stub (demo the feature on generated data and describe the substitution in detail). Never drop a data-backed feature or steer the demo away from it.`,
    );
  }
}

/**
 * Rejects preparation output that switches away from a locked browser app:
 * the appDir stays locked and every feature anchors to the selected app by
 * citing at least one of its paths. Paths under sibling client directories
 * are legitimate supplementary context — a selected server app can build and
 * serve a client that lives in a sibling directory (ghost's admin client,
 * N162), so directory ownership alone never rejects a manifest.
 */
function assertPreparationRuntimeTarget(input: {
  preparationManifest: PreparationManifest;
  repoProfile?: RepoProfile;
  runPlan?: RunPlan;
}): void {
  const targetId = input.runPlan?.targetSelection?.targetId;
  if (targetId === undefined || input.repoProfile === undefined) return;
  if (input.preparationManifest.appDir !== targetId) {
    throw new Error(
      `PreparationManifest.appDir must remain locked to ${targetId}; received ${input.preparationManifest.appDir}`,
    );
  }
  for (const [
    index,
    feature,
  ] of input.preparationManifest.productContext.featureInventory.entries()) {
    if (!feature.sourcePaths.some((path) => isWithin(path, targetId))) {
      throw new Error(
        `productContext.featureInventory[${index}].sourcePaths must cite the selected browser application ${targetId} with at least one path. Paths in sibling client applications may accompany that anchor when the selected application builds or serves them, but never replace it.`,
      );
    }
  }
}

function isWithin(path: string, directory: string): boolean {
  return (
    directory === "." || path === directory || path.startsWith(`${directory}/`)
  );
}

function isBrowserUiSourcePath(path: string) {
  return (
    /\.(?:html|jsx|tsx|svelte|vue)$/i.test(path) ||
    /(?:^|\/)(?:app|client|index|main|router|routes)\.(?:js|mjs|mts|ts)$/i.test(
      path,
    ) ||
    (/(?:^|\/)(?:app|components|pages|routes|screens|views)(?:\/|$)/i.test(
      path,
    ) &&
      /\.(?:js|mjs|mts|ts)$/i.test(path))
  );
}

function collectUnknownSourcePaths(
  paths: string[],
  repoSourcePaths: ReadonlySet<string>,
  fieldPath: string,
): string[] {
  return paths.flatMap((path, index) =>
    repoSourcePaths.has(path) ? [] : [`${fieldPath}[${index}] ${path}`],
  );
}

/** Counts maker-requested features by their normalized comparison key. */
export function countNormalizedFeatures(
  features: string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const feature of features) {
    const normalized = normalizeFeature(feature);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

/**
 * Normalizes one requested-feature string for equality checks: trimmed,
 * whitespace-collapsed, lowercased. Every feature-coverage comparison in the
 * pipeline must use this key so the same submitted text always matches.
 */
export function normalizeFeature(feature: string): string {
  return feature.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

/** Lists features counted more times on the left than the right, repeated per missing count. */
export function readFeatureCountDifference(
  left: Map<string, number>,
  right: Map<string, number>,
): string[] {
  const difference: string[] = [];
  for (const [feature, leftCount] of left) {
    const count = Math.max(0, leftCount - (right.get(feature) ?? 0));
    difference.push(...Array.from({ length: count }, () => feature));
  }
  return difference;
}
