/**
 * Reads a human-readable message from an unknown thrown value: an Error's
 * own message, or the value coerced to a string. The one shared spelling for
 * every catch block that reports rather than rethrows.
 */
export function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
