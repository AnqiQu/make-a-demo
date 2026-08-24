/**
 * Builds a one-key record spread for an optional string field: `{ [key]:
 * value }` when `value` carries non-whitespace content, `{}` otherwise.
 * Artifact builders spread the result so optional fields are omitted rather
 * than serialized as `undefined` or empty strings.
 */
export function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined || value.trim().length === 0
    ? {}
    : ({ [key]: value } as Partial<Record<K, string>>);
}
