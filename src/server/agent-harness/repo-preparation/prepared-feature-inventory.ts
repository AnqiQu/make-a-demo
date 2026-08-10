import type {
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
      )}. Declare the typed browser-checkable outcome that proves each feature on its entry route — visible-text (an exact on-screen string), element-appears (a visible element's accessible name), or state-transition (click the control named locator while its state reads from and observe state to).`,
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
    const locatorValues =
      proof.kind === "visible-text"
        ? []
        : proof.kind === "element-appears"
          ? [proof.name]
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

/** Rejects preparation output that switches away from a locked browser app. */
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
  const siblingTargets = (input.repoProfile.browserRuntimeCandidates ?? [])
    .map(({ dir }) => dir)
    .filter((dir) => dir !== targetId && dir !== ".");
  for (const [field, paths] of [
    [
      "productContext.evidencePaths",
      input.preparationManifest.productContext.evidencePaths,
    ],
    ...input.preparationManifest.productContext.featureInventory.map(
      (feature, index) => [
        `productContext.featureInventory[${index}].sourcePaths`,
        feature.sourcePaths,
      ],
    ),
  ] as Array<[string, string[]]>) {
    for (const path of paths) {
      const sibling = siblingTargets.find((dir) => isWithin(path, dir));
      if (sibling !== undefined) {
        throw new Error(
          `${field} path ${path} belongs to non-selected browser application ${sibling}`,
        );
      }
    }
  }
  for (const [
    index,
    feature,
  ] of input.preparationManifest.productContext.featureInventory.entries()) {
    if (!feature.sourcePaths.some((path) => isWithin(path, targetId))) {
      throw new Error(
        `productContext.featureInventory[${index}].sourcePaths must cite the selected browser application ${targetId}`,
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
