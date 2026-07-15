import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import type { NetworkAttempt } from "../../agent-harness/schemas/artifacts";
import {
  type ExternalResourceManifest,
  externalResourceManifestVersion,
} from "./external-resource-manifest.schema";

const eligibleResourceTypes = new Set([
  "fetch",
  "font",
  "image",
  "media",
  "script",
  "stylesheet",
  "xhr",
]);

export type ExternalResourceFetchResult = {
  body: Uint8Array;
  contentType: string;
  headers: Record<string, string>;
  status: number;
};

export type ExternalResourceFetcher = (
  url: string,
) => Promise<ExternalResourceFetchResult>;

export type ExternalResourceHostResolver = (
  hostname: string,
) => Promise<string[]>;

const maximumResourceBytes = 128 * 1024 * 1024;
const maximumCacheBytes = 512 * 1024 * 1024;
const maximumCacheEntries = 256;
const maximumRedirects = 5;
const hydrationConcurrency = 6;
const externalResourceRequestTimeoutMs = 30_000;

/** Returns whether a blocked browser request is safe to hydrate without credentials. */
export function isHydratableExternalResource(attempt: NetworkAttempt): boolean {
  return (
    attempt.direction === "outbound" &&
    attempt.phase !== "dependency-install" &&
    attempt.method === "GET" &&
    attempt.hasCredentials !== true &&
    attempt.url?.startsWith("https://") === true &&
    attempt.resourceType !== undefined &&
    eligibleResourceTypes.has(attempt.resourceType)
  );
}

/**
 * Produces an exact browser pass-through allowlist after resolving every host
 * to public addresses. The browser must still enforce method, credential, and
 * resource-type checks for the live request.
 */
export async function authorizeExternalResourcePassthrough(input: {
  attempts: NetworkAttempt[];
  onFailure?: (input: { error: unknown; url: string }) => Promise<void> | void;
  resolveHost?: ExternalResourceHostResolver;
}): Promise<{
  attempts: NetworkAttempt[];
  hosts: string[];
  urls: string[];
}> {
  const resolveHost =
    input.resolveHost ??
    (async (hostname: string) =>
      (await lookup(hostname, { all: true, verbatim: true })).map(
        ({ address }) => address,
      ));
  const attemptsByUrl = new Map(
    input.attempts
      .filter(isHydratableExternalResource)
      .map((attempt) => [attempt.url as string, attempt]),
  );
  const approvedAttempts: NetworkAttempt[] = [];
  const approvedHosts = new Set<string>();
  const addressResolutions = new Map<string, Promise<string[]>>();
  for (const [url, attempt] of attemptsByUrl) {
    try {
      const destination = new URL(url);
      if (
        destination.protocol !== "https:" ||
        destination.username.length > 0 ||
        destination.password.length > 0
      ) {
        throw new Error(
          `External resource ${url} must be a credential-free HTTPS URL.`,
        );
      }
      const hostname = destination.hostname.toLowerCase();
      const addressesPromise =
        addressResolutions.get(hostname) ?? resolveHost(hostname);
      addressResolutions.set(hostname, addressesPromise);
      const addresses = await addressesPromise;
      if (
        addresses.length === 0 ||
        addresses.some((address) => !isPublicIp(address))
      ) {
        throw new Error(
          `External resource ${url} did not resolve exclusively to public addresses.`,
        );
      }
      approvedAttempts.push(attempt);
      approvedHosts.add(hostname);
    } catch (error) {
      await input.onFailure?.({ error, url });
    }
  }
  return {
    attempts: approvedAttempts,
    hosts: [...approvedHosts].sort(),
    urls: approvedAttempts.map((attempt) => attempt.url as string).sort(),
  };
}

/**
 * Materializes safe browser resources into a content-addressed local cache.
 * The fetcher must not forward submitted-code cookies or authorization data.
 */
export async function hydrateExternalResourceCache(input: {
  attempts: NetworkAttempt[];
  directory: string;
  existingManifest?: ExternalResourceManifest;
  fetchResource?: ExternalResourceFetcher;
  onFailure?: (input: {
    error: unknown;
    url: string;
  }) => Promise<void> | void;
  requestTimeoutMs?: number;
}): Promise<ExternalResourceManifest> {
  const resourcesDirectory = join(input.directory, "resources");
  await mkdir(resourcesDirectory, { recursive: true });
  const existingEntries = input.existingManifest?.entries ?? [];
  const existingUrls = new Set(existingEntries.map((entry) => entry.url));
  const attemptsByUrl = new Map(
    input.attempts
      .filter(isHydratableExternalResource)
      .map((attempt) => [attempt.url as string, attempt]),
  );
  const discoveredUrls = [
    ...new Set(
      [...attemptsByUrl.keys()].filter((url) => !existingUrls.has(url)),
    ),
  ];
  const availableEntryCount = Math.max(
    0,
    maximumCacheEntries - existingEntries.length,
  );
  const urls = discoveredUrls.slice(0, availableEntryCount);
  for (const url of discoveredUrls.slice(availableEntryCount)) {
    await input.onFailure?.({
      error: new Error(
        `External resource cache exceeded ${maximumCacheEntries} entries.`,
      ),
      url,
    });
  }
  const entries = [...existingEntries];
  const hydratedEntries = new Map<
    string,
    ExternalResourceManifest["entries"][number]
  >();
  let nextUrlIndex = 0;
  let totalBytes = existingEntries.reduce(
    (total, entry) => total + entry.sizeBytes,
    0,
  );
  const fetchResource = input.fetchResource ?? fetchExternalResource;
  const hydrateNext = async () => {
    for (;;) {
      const url = urls[nextUrlIndex];
      nextUrlIndex += 1;
      if (url === undefined) return;
      try {
        const response = await withTimeout(
          fetchResource(url),
          input.requestTimeoutMs ?? externalResourceRequestTimeoutMs,
          url,
        );
        if (response.status < 200 || response.status > 299) {
          throw new Error(
            `External resource ${url} returned HTTP ${response.status}.`,
          );
        }
        assertCompatibleContentType(
          attemptsByUrl.get(url)?.resourceType,
          response.contentType,
        );
        totalBytes += response.body.byteLength;
        if (totalBytes > maximumCacheBytes) {
          throw new Error(
            "External resource cache exceeded the 512 MiB limit.",
          );
        }
        const digest = createHash("sha256").update(response.body).digest("hex");
        const relativePath = `resources/${digest}`;
        await writeFile(join(input.directory, relativePath), response.body);
        hydratedEntries.set(url, {
          contentType: response.contentType,
          headers: {
            ...readReplayHeaders(response.headers),
            "access-control-allow-origin": "*",
          },
          relativePath,
          sha256: `sha256:${digest}` as const,
          sizeBytes: response.body.byteLength,
          status: response.status,
          url,
        });
      } catch (error) {
        await input.onFailure?.({ error, url });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(hydrationConcurrency, urls.length) },
      hydrateNext,
    ),
  );
  entries.push(
    ...urls.flatMap((url) => {
      const entry = hydratedEntries.get(url);
      return entry === undefined ? [] : [entry];
    }),
  );
  return { entries, version: externalResourceManifestVersion };
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  url: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `External resource ${url} did not respond within ${timeoutMs}ms.`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Verifies that every replay body still matches its backend-owned manifest. */
export async function verifyExternalResourceCache(input: {
  directory: string;
  manifest: ExternalResourceManifest;
}) {
  for (const entry of input.manifest.entries) {
    const body = await readFile(join(input.directory, entry.relativePath));
    const sha256 = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    if (body.byteLength !== entry.sizeBytes || sha256 !== entry.sha256) {
      throw new Error(
        `External resource cache integrity failed for ${entry.url}.`,
      );
    }
  }
}

/** Fetches one public HTTPS resource without submitted-code headers or cookies. */
export async function fetchExternalResource(
  url: string,
): Promise<ExternalResourceFetchResult> {
  return await requestExternalResource(new URL(url), 0);
}

async function requestExternalResource(
  url: URL,
  redirects: number,
): Promise<ExternalResourceFetchResult> {
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("External resources require a public HTTPS destination.");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const address = addresses.find((candidate) => isPublicIp(candidate.address));
  if (
    address === undefined ||
    addresses.some((candidate) => !isPublicIp(candidate.address))
  ) {
    throw new Error("External resources require a public HTTPS destination.");
  }

  return await new Promise<ExternalResourceFetchResult>((resolve, reject) => {
    const outbound = request(
      url,
      {
        headers: {
          accept: "*/*",
          "user-agent": "MakeADemo-External-Resource-Hydrator/1",
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, address.address, address.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location !== undefined) {
          response.resume();
          if (redirects >= maximumRedirects) {
            reject(new Error("External resource exceeded the redirect limit."));
            return;
          }
          requestExternalResource(new URL(location, url), redirects + 1).then(
            resolve,
            reject,
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maximumResourceBytes) {
            outbound.destroy(
              new Error("External resource exceeded the 128 MiB limit."),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const contentType = response.headers["content-type"]
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          if (contentType === undefined || contentType.length === 0) {
            reject(
              new Error("External resource response omitted Content-Type."),
            );
            return;
          }
          resolve({
            body: Buffer.concat(chunks),
            contentType,
            headers: readReplayHeaders(response.headers),
            status,
          });
        });
      },
    );
    outbound.on("error", reject);
    outbound.setTimeout(externalResourceRequestTimeoutMs, () => {
      outbound.destroy(
        new Error(
          `External resource ${url.href} did not respond within ${externalResourceRequestTimeoutMs}ms.`,
        ),
      );
    });
    outbound.end();
  });
}

function readReplayHeaders(
  headers: Record<string, string | string[] | undefined>,
) {
  const replayHeaders: Record<string, string> = {};
  const cacheControl = headers["cache-control"];
  if (typeof cacheControl === "string") {
    replayHeaders["cache-control"] = cacheControl;
  }
  return replayHeaders;
}

function assertCompatibleContentType(
  resourceType: string | undefined,
  contentType: string,
) {
  const value = contentType.toLowerCase();
  const compatible =
    resourceType === "image"
      ? value.startsWith("image/")
      : resourceType === "media"
        ? /^(?:audio|video)\//.test(value)
        : resourceType === "font"
          ? /^(?:font\/|application\/(?:font|octet-stream|vnd\.ms-fontobject))/.test(
              value,
            )
          : resourceType === "stylesheet"
            ? value === "text/css"
            : resourceType === "script"
              ? /(?:javascript|ecmascript)$/.test(value)
              : resourceType === "fetch" || resourceType === "xhr"
                ? /^(?:application\/json|image\/|text\/)/.test(value)
                : false;
  if (!compatible) {
    throw new Error(
      `External ${resourceType ?? "unknown"} resource returned incompatible Content-Type ${contentType}.`,
    );
  }
}

function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 2, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isPublicIp(normalized.slice("::ffff:".length));
    }
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      /^(?:fc|fd|fe[89ab]|ff)/.test(normalized) ||
      normalized.startsWith("2001:db8:")
    );
  }
  return false;
}
