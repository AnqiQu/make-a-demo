import type { PreparationManifest } from "../schemas/artifacts";

const templateValuePattern = /^replace-with-/i;

/**
 * Verifies that Repo Preparation produced source-backed, browser-addressable
 * product context and prepared every maker-requested feature exactly once.
 */
export function assertPreparedFeatureInventory(input: {
  demoBrief: { keyProductFeatures?: string[] };
  preparationManifest: PreparationManifest;
  repoSourcePaths: ReadonlySet<string>;
}): void {
  const context = input.preparationManifest.productContext;
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
  assertKnownSourcePaths(
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
    const path = `productContext.featureInventory[${index}]`;
    if (feature.sourcePaths.length === 0) {
      throw new Error(`${path}.sourcePaths must contain source evidence`);
    }
    assertKnownSourcePaths(
      feature.sourcePaths,
      input.repoSourcePaths,
      `${path}.sourcePaths`,
    );
    if (feature.entryPaths.length === 0) {
      throw new Error(`${path}.entryPaths must contain a local app path`);
    }
  }

  const requestedFeatures = input.demoBrief.keyProductFeatures ?? [];
  if (requestedFeatures.length === 0) {
    return;
  }
  const preparedRequestedFeatures = context.featureInventory.flatMap(
    (feature) =>
      feature.requestedFeature === undefined ? [] : [feature.requestedFeature],
  );
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

function assertKnownSourcePaths(
  paths: string[],
  repoSourcePaths: ReadonlySet<string>,
  fieldPath: string,
): void {
  for (const [index, path] of paths.entries()) {
    if (!repoSourcePaths.has(path)) {
      throw new Error(
        `${fieldPath}[${index}] references unknown screened source path ${path}`,
      );
    }
  }
}

function countNormalizedFeatures(features: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const feature of features) {
    const normalized = normalizeFeature(feature);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function normalizeFeature(feature: string): string {
  return feature.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

function readFeatureCountDifference(
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
