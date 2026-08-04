/**
 * Primitive readers for validating persisted JSON records (pipeline artifacts,
 * manifests) at the moment they re-enter the process. Error messages name the
 * offending path and are part of each artifact's read contract, so consumers
 * must not vary the wording per call site.
 */

/** Joins a parent path and key into the dotted path used by reader errors. */
export function childPath(parentPath: string | undefined, key: string): string {
  return parentPath ? `${parentPath}.${key}` : key;
}

export function assertRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): string {
  const path = childPath(parentPath, key);
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

export function readBoolean(
  record: Record<string, unknown>,
  key: string,
  parentPath?: string,
): boolean {
  const path = childPath(parentPath, key);
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}
