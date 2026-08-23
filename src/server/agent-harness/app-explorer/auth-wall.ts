/** Browser-visible route evidence used to recognize authentication walls. */
export type AuthWallRouteObservation = {
  buttons: string[];
  forms?: string[];
  headings: string[];
  inputs: string[];
  links?: Array<{ name: string }>;
  path?: string;
  requestedPath?: string;
  title?: string;
};

/**
 * Recognizes the route-token shape shared by observed auth walls, click
 * destinations, and redirect gates. Callers must add the evidence appropriate
 * to their seam: route observations corroborate it with auth controls, while
 * a click or HTTP redirect supplies the navigation evidence itself.
 */
export function hasAuthWallRouteShape(path: string | undefined): boolean {
  return /(?:^|[/#?_-])(?:auth|log-?in|oauth|sign-?in|sign-?up|sso)(?:[/#?&=_-]|$)/i.test(
    path ?? "",
  );
}

/** Returns true when a harvested route visibly presents authentication. */
export function isAuthWallRoute(route: AuthWallRouteObservation): boolean {
  const actionLabels = [
    ...route.buttons,
    ...(route.links ?? []).map(({ name }) => name),
  ];
  const hasPassword = route.inputs.some((input) => /password/i.test(input));
  const hasIdentity = route.inputs.some((input) =>
    /email|username|user name/i.test(input),
  );
  const hasIdentityProviderAction = actionLabels.some((button) =>
    /\b(?:continue|log in|sign in)\s+(?:with\s+)?(?:apple|facebook|github|google|linkedin|microsoft|sso)\b/i.test(
      button,
    ),
  );
  const redirected =
    route.requestedPath !== undefined && route.requestedPath !== route.path;
  // A password + identity pair is a login form regardless of copy; an
  // auth-looking path alone is not — marketing pages reuse those slugs, so
  // the path must be corroborated by a credential input or provider button.
  return (
    (hasPassword && hasIdentity) ||
    (hasAuthWallRouteShape(route.path) &&
      (hasPassword || hasIdentity || hasIdentityProviderAction)) ||
    (redirected && hasIdentityProviderAction)
  );
}

/** A click whose observed destination is authentication cannot prove a feature. */
export function isAuthDegradedClick(action: {
  kind: string;
  navigationDestination?: string;
}): boolean {
  return (
    action.kind === "click" &&
    hasAuthWallRouteShape(action.navigationDestination)
  );
}
