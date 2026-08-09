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
      if (
        segment.startsWith(":") ||
        segment.includes("*") ||
        /[[\]{}]/.test(segment)
      ) {
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
