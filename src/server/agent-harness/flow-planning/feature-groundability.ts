import type { ActionCatalog } from "../schemas/artifacts";

/**
 * The one groundability rule Flow Planning and its validator must share: a
 * prepared feature is groundable when the ActionCatalog tags at least one
 * visible assertion for it on a route the FlowSpec may select (login/auth
 * wall routes are excluded — authentication happens off camera). Every other
 * per-feature FlowSpec rule is satisfiability-guarded, so assert
 * availability is the only demand that can make a feature impossible to
 * plan. Feature selection must count features with this predicate — never
 * with raw inventory length — or the planner can be ordered to select a
 * feature no valid FlowSpec may contain (homer, 2026-08-13 matrix).
 */
export function isFeatureGroundable(
  featureId: string,
  input: {
    actionCatalog: ActionCatalog;
    authWallRoutes: ReadonlySet<string>;
  },
): boolean {
  return input.actionCatalog.actions.some(
    (action) =>
      action.kind === "assert" &&
      (action.featureIds ?? []).includes(featureId) &&
      !input.authWallRoutes.has(action.route),
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
    authWallRoutes: ReadonlySet<string>;
  },
): string[] {
  return featureIds.filter((featureId) =>
    isFeatureGroundable(featureId, input),
  );
}
