export const externalResourceManifestVersion = "2026-07-14" as const;

type ExternalResourceEntry = {
  contentType: string;
  headers: Record<string, string>;
  relativePath: string;
  sha256: `sha256:${string}`;
  sizeBytes: number;
  status: number;
  url: string;
};

export type ExternalResourceManifest = {
  entries: ExternalResourceEntry[];
  version: typeof externalResourceManifestVersion;
};

/**
 * Reads a backend-generated external-resource manifest. Consumers must still
 * verify each resource body against its declared hash before browser replay.
 */
export function readExternalResourceManifest(
  value: unknown,
): ExternalResourceManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("External Resource Manifest must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== externalResourceManifestVersion) {
    throw new Error("Unsupported External Resource Manifest version.");
  }
  if (!Array.isArray(record.entries)) {
    throw new Error("External Resource Manifest entries must be an array.");
  }
  return {
    entries: record.entries.map(readEntry),
    version: externalResourceManifestVersion,
  };
}

function readEntry(value: unknown, index: number): ExternalResourceEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `External Resource Manifest entries[${index}] must be an object.`,
    );
  }
  const entry = value as Record<string, unknown>;
  const url = readString(entry, "url", index);
  if (!url.startsWith("https://")) {
    throw new Error(
      `External Resource Manifest entries[${index}].url must use HTTPS.`,
    );
  }
  const sha256 = readString(entry, "sha256", index);
  if (!/^sha256:[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(
      `External Resource Manifest entries[${index}].sha256 is invalid.`,
    );
  }
  const relativePath = readString(entry, "relativePath", index);
  if (!/^resources\/[a-f0-9]{64}$/.test(relativePath)) {
    throw new Error(
      `External Resource Manifest entries[${index}].relativePath is invalid.`,
    );
  }
  if (
    typeof entry.sizeBytes !== "number" ||
    !Number.isSafeInteger(entry.sizeBytes) ||
    entry.sizeBytes < 0
  ) {
    throw new Error(
      `External Resource Manifest entries[${index}].sizeBytes is invalid.`,
    );
  }
  if (
    typeof entry.status !== "number" ||
    !Number.isInteger(entry.status) ||
    entry.status < 200 ||
    entry.status > 299
  ) {
    throw new Error(
      `External Resource Manifest entries[${index}].status is invalid.`,
    );
  }
  const headers = entry.headers;
  if (
    typeof headers !== "object" ||
    headers === null ||
    Array.isArray(headers)
  ) {
    throw new Error(
      `External Resource Manifest entries[${index}].headers must be an object.`,
    );
  }
  return {
    contentType: readString(entry, "contentType", index),
    headers: Object.fromEntries(
      Object.entries(headers).map(([key, header]) => {
        if (typeof header !== "string") {
          throw new Error(
            `External Resource Manifest entries[${index}].headers.${key} must be a string.`,
          );
        }
        return [key, header];
      }),
    ),
    relativePath,
    sha256: sha256 as `sha256:${string}`,
    sizeBytes: entry.sizeBytes,
    status: entry.status,
    url,
  };
}

function readString(
  record: Record<string, unknown>,
  key: string,
  index: number,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `External Resource Manifest entries[${index}].${key} must be a non-empty string.`,
    );
  }
  return value;
}
