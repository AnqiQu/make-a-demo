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
  if (missing.length === 0 && unexpected.length === 0) {
    return;
  }

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
