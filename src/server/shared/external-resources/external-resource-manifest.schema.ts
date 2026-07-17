export const externalResourceManifestVersion = "2026-07-15" as const;
const replaySafeHeaders = new Set([
  "access-control-allow-origin",
  "cache-control",
  "cross-origin-resource-policy",
  "timing-allow-origin",
]);

type ExternalResourceEntry = {
  contentType: string;
  headers: Record<string, string>;
  relativePath: string;
  responseUrl?: string;
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
  const entries = record.entries.map(readEntry);
  const urls = new Set<string>();
  const replaySignatures = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    if (urls.has(entry.url)) {
      throw new Error(
        `External Resource Manifest entries[${index}].url URL must be unique.`,
      );
    }
    urls.add(entry.url);
    const responseSignature = JSON.stringify({
      contentType: entry.contentType,
      headers: Object.fromEntries(Object.entries(entry.headers).sort()),
      relativePath: entry.relativePath,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      status: entry.status,
    });
    const mappings: Array<readonly [string, string]> =
      entry.responseUrl === undefined
        ? [[entry.url, responseSignature]]
        : [
            [entry.url, `redirect:${entry.responseUrl}`],
            [entry.responseUrl, responseSignature],
          ];
    for (const [url, signature] of mappings) {
      const previous = replaySignatures.get(url);
      if (previous !== undefined && previous !== signature) {
        throw new Error(
          `External Resource Manifest URL ${url} has conflicting replay responses.`,
        );
      }
      replaySignatures.set(url, signature);
    }
  }
  return { entries, version: externalResourceManifestVersion };
}

function readEntry(value: unknown, index: number): ExternalResourceEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `External Resource Manifest entries[${index}] must be an object.`,
    );
  }
  const entry = value as Record<string, unknown>;
  const url = readHttpsUrl(entry, "url", index);
  const contentType = readString(entry, "contentType", index);
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(contentType)) {
    throw new Error(
      `External Resource Manifest entries[${index}].contentType is invalid.`,
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
    contentType,
    headers: Object.fromEntries(
      Object.entries(headers).map(([key, header]) => {
        if (key !== key.toLowerCase() || !replaySafeHeaders.has(key)) {
          throw new Error(
            `External Resource Manifest entries[${index}] header ${key} is not replay-safe.`,
          );
        }
        if (typeof header !== "string") {
          throw new Error(
            `External Resource Manifest entries[${index}].headers.${key} must be a string.`,
          );
        }
        if (/[\r\n]/.test(header)) {
          throw new Error(
            `External Resource Manifest entries[${index}].headers.${key} contains a line break.`,
          );
        }
        return [key, header];
      }),
    ),
    relativePath,
    ...(entry.responseUrl === undefined
      ? {}
      : { responseUrl: readHttpsUrl(entry, "responseUrl", index) }),
    sha256: sha256 as `sha256:${string}`,
    sizeBytes: entry.sizeBytes,
    status: entry.status,
    url,
  };
}

function readHttpsUrl(
  record: Record<string, unknown>,
  key: string,
  index: number,
): string {
  const value = readString(record, key, index);
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      `External Resource Manifest entries[${index}].${key} must be a credential-free HTTPS URL.`,
    );
  }
  return value;
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
