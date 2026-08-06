/**
 * Escapes a literal string for safe embedding inside a RegExp pattern: every
 * RegExp metacharacter in `value` is backslash-escaped so the result matches
 * `value` exactly, never as a pattern.
 */
export function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
