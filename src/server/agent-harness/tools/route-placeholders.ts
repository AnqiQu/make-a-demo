/**
 * Detects router-pattern placeholders in agent-declared demo routes.
 *
 * Preparation agents copy route definitions out of router files
 * (`/collection/:collectionSlug`, `/docs/[...slug]`), and a placeholder
 * navigated verbatim is a guaranteed 404 — the 2026-08-08 outline video
 * opened on one. `findRoutePlaceholder` returns the first pattern segment of
 * a path (searching both the URL path and a hash-router path, ignoring query
 * strings, where colons and asterisks are legitimate data), or undefined for
 * a concrete navigable route. Callers reject or drop flagged routes; they
 * must never rewrite them, because only the agent knows its fixture slugs.
 */
export function findRoutePlaceholder(path: string): string | undefined {
  return findPathSegment(
    path,
    (segment) =>
      segment.startsWith(":") ||
      segment.includes("*") ||
      /[[\]{}]/.test(segment),
  );
}

/**
 * Detects a missing-value interpolation in a navigation path (N158).
 *
 * An app that builds a URL from an unset value emits the literal `undefined`
 * or `null` into the path (excalidraw's marketing banner rendered
 * `/undefined/plus?...` from an unset env var, and the compiled demo script
 * waited on that URL forever). Returns the offending segment, searching the
 * URL path and a hash-router path the same way `findRoutePlaceholder` does,
 * or undefined for a path with no interpolated hole. Callers must drop the
 * destination rather than rewrite it — only the app knows what belonged
 * there.
 */
export function findMissingValueSegment(path: string): string | undefined {
  return findPathSegment(
    path,
    (segment) => segment === "undefined" || segment === "null",
  );
}

/**
 * Walks the decoded segments of a path's URL pathname and hash-router path
 * (query strings ignored) and returns the first segment the predicate flags,
 * or undefined when the path cannot parse or no segment matches.
 */
function findPathSegment(
  path: string,
  flagsSegment: (segment: string) => boolean,
): string | undefined {
  let url: URL;
  try {
    url = new URL(path, "http://makeademo.invalid");
  } catch {
    return undefined;
  }
  const hashPath = url.hash.split("?")[0] ?? "";
  for (const routePart of [url.pathname, hashPath]) {
    for (const rawSegment of routePart.split("/")) {
      const segment = decodeSegment(rawSegment);
      if (segment.length === 0) continue;
      if (flagsSegment(segment)) {
        return segment;
      }
    }
  }
  return undefined;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
