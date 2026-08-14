import { isAuthDegradedClick } from "../app-explorer/auth-wall";
import type { ActionCatalog } from "../schemas/artifacts";

/**
 * The one groundability rule Flow Planning and its validator must share: a
 * prepared feature is groundable when the ActionCatalog tags a visible
 * assertion and a usable interaction for it on selectable routes. A feature
 * with exercised interactions is behavioral, so at least one exercised
 * interaction must remain after auth-degraded clicks are removed; genuinely
 * read-only features may use their observed navigation. Feature selection
 * must count this predicate — never raw inventory length — or the planner can
 * be ordered to select a feature no valid FlowSpec may contain.
 */
export function isFeatureGroundable(
  featureId: string,
  input: {
    actionCatalog: ActionCatalog;
    allowedAuthWallFeatureIds?: ReadonlySet<string>;
    authWallRoutes: ReadonlySet<string>;
  },
): boolean {
  const authEvidenceAllowed =
    input.allowedAuthWallFeatureIds?.has(featureId) === true;
  const actions = input.actionCatalog.actions.filter(
    (action) =>
      (action.featureIds ?? []).includes(featureId) &&
      (authEvidenceAllowed || !input.authWallRoutes.has(action.route)),
  );
  const hasAssert = actions.some((action) => action.kind === "assert");
  if (!hasAssert) return false;
  const exercised = actions.filter((action) => action.exercised === true);
  if (exercised.length > 0) {
    return exercised.some(
      (action) => authEvidenceAllowed || !isAuthDegradedClick(action),
    );
  }
  return actions.some(
    (action) =>
      action.kind !== "assert" &&
      (authEvidenceAllowed || !isAuthDegradedClick(action)),
  );
}

/**
 * Filters prepared feature ids to the groundable ones, preserving inventory
 * order so selection messages and retry hints enumerate features the way the
 * planner sees them.
 */
export function readGroundableFeatureIds(
  featureIds: readonly string[],
  input: {
    actionCatalog: ActionCatalog;
    allowedAuthWallFeatureIds?: ReadonlySet<string>;
    authWallRoutes: ReadonlySet<string>;
  },
): string[] {
  return featureIds.filter((featureId) =>
    isFeatureGroundable(featureId, input),
  );
}
