import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
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
  "stylesheet",
  "xhr",
]);
const credentialQueryParameter =
  /^(?:access[_-]?token|api[_-]?key|auth(?:orization)?|credential|password|secret|sig(?:nature)?|token|x-amz-(?:credential|security-token|signature)|x-goog-(?:credential|signature))$/i;

export type ExternalResourceFetchResult = {
  body: Uint8Array;
  contentType: string;
  finalUrl?: string;
  headers: Record<string, string>;
  status: number;
};

export type ExternalResourceFetcher = (
  url: string,
  signal: AbortSignal,
) => Promise<ExternalResourceFetchResult>;

export type ExternalResourceFailureReason =
  | "policy-denied"
  | "retrieval-failed";

class ExternalResourcePolicyError extends Error {}

/** Marks a fetcher-thrown TypeError so hydration can rethrow the original. */
class ExternalResourceFetcherContractError extends Error {
  override readonly cause: TypeError;

  constructor(cause: TypeError) {
    super(cause.message);
    this.name = "ExternalResourceFetcherContractError";
    this.cause = cause;
  }
}

const maximumResourceBytes = 128 * 1024 * 1024;
const maximumCacheBytes = 512 * 1024 * 1024;
const maximumCacheEntries = 256;
const maximumRedirects = 5;
const hydrationConcurrency = 6;
const externalResourceRequestTimeoutMs = 30_000;
const nonPublicAddresses = createNonPublicAddressBlockList();

/** Returns whether a blocked presentation request can enter controller hydration. */
export function isHydratableExternalResource(
  attempt: NetworkAttempt,
): attempt is NetworkAttempt & {
  method: "GET";
  resourceType: string;
  url: string;
} {
  return (
    attempt.direction === "outbound" &&
    attempt.phase !== "dependency-install" &&
    attempt.method === "GET" &&
    attempt.hasCredentials !== true &&
    attempt.url !== undefined &&
    isCredentialFreeResourceUrl(attempt.url) &&
    attempt.resourceType !== undefined &&
    eligibleResourceTypes.has(attempt.resourceType)
  );
}

function isCredentialFreeResourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      // A non-standard port points at an internal service rather than a public
      // asset host, so presentation resources are limited to the default port.
      (url.port === "" || url.port === "443") &&
      isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0 &&
      [...url.searchParams.keys()].every(
        (key) => !credentialQueryParameter.test(key),
      )
    );
  } catch {
    return false;
  }
}

/**
 * Applies the destination policy to whatever URL a fetcher actually reached.
 * Callers may inject their own fetcher, so the address check cannot live only
 * inside the built-in request path: a fetcher that follows a redirect to a
 * private address must still be denied here.
 */
async function assertPublicResourceDestination(
  requestedUrl: string,
  finalUrl: string,
): Promise<void> {
  if (!isCredentialFreeResourceUrl(finalUrl)) {
    throw new ExternalResourcePolicyError(
      `External resource ${requestedUrl} redirected to an unsafe destination.`,
    );
  }
  const finalHostname = new URL(finalUrl).hostname;
  if (finalHostname === new URL(requestedUrl).hostname) {
    // The requested host already passed the pre-fetch address policy; only a
    // redirect to a different host needs to be resolved again here.
    return;
  }
  const addresses = await lookup(finalHostname, { all: true, verbatim: true });
  if (addresses.some((candidate) => !isPublicIp(candidate.address))) {
    throw new ExternalResourcePolicyError(
      `External resource ${requestedUrl} redirected to a non-public address.`,
    );
  }
}

/**
 * Materializes safe presentation resources into a content-addressed local cache.
 * The fetcher must not forward submitted-code cookies or authorization data.
 */
export async function hydrateExternalResourceCache(input: {
  attempts: NetworkAttempt[];
  directory: string;
  existingManifest?: ExternalResourceManifest;
  fetchResource?: ExternalResourceFetcher;
  onFailure?: (input: {
    error: unknown;
    reason: ExternalResourceFailureReason;
    url: string;
  }) => Promise<void> | void;
  requestTimeoutMs?: number;
}): Promise<ExternalResourceManifest> {
  const resourcesDirectory = join(input.directory, "resources");
  await mkdir(resourcesDirectory, { recursive: true });
  const existingEntries = input.existingManifest?.entries ?? [];
  const existingUrls = new Set(
    existingEntries.flatMap((entry) => [
      entry.url,
      ...(entry.responseUrl === undefined ? [] : [entry.responseUrl]),
    ]),
  );
  const attemptsByUrl = new Map(
    input.attempts
      .filter(isHydratableExternalResource)
      .map((attempt) => [attempt.url, attempt]),
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
      reason: "retrieval-failed",
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
          (signal) =>
            fetchResource(url, signal).catch((error: unknown) => {
              // A TypeError raised by the fetcher itself is a controller
              // contract break, not something this response can recover from.
              throw error instanceof TypeError
                ? new ExternalResourceFetcherContractError(error)
                : error;
            }),
          input.requestTimeoutMs ?? externalResourceRequestTimeoutMs,
          url,
        );
        if (response.status < 200 || response.status > 299) {
          throw new Error(
            `External resource ${url} returned HTTP ${response.status}.`,
          );
        }
        const responseUrl = response.finalUrl ?? url;
        await assertPublicResourceDestination(url, responseUrl);
        const contentType = normalizeContentType(response.contentType);
        assertCompatibleContentType(
          attemptsByUrl.get(url)?.resourceType,
          contentType,
        );
        if (response.body.byteLength > maximumResourceBytes) {
          throw new Error("External resource exceeded the 128 MiB limit.");
        }
        if (totalBytes + response.body.byteLength > maximumCacheBytes) {
          throw new Error(
            "External resource cache exceeded the 512 MiB limit.",
          );
        }
        totalBytes += response.body.byteLength;
        const digest = createHash("sha256").update(response.body).digest("hex");
        const relativePath = `resources/${digest}`;
        await writeFile(join(input.directory, relativePath), response.body);
        hydratedEntries.set(url, {
          contentType,
          headers: {
            ...readReplayHeaders(response.headers),
            "access-control-allow-origin": "*",
            "cross-origin-resource-policy": "cross-origin",
          },
          relativePath,
          ...(responseUrl === url ? {} : { responseUrl }),
          sha256: `sha256:${digest}` as const,
          sizeBytes: response.body.byteLength,
          status: response.status,
          url,
        });
      } catch (error) {
        if (error instanceof ExternalResourceFetcherContractError) {
          throw error.cause;
        }
        // One hostile or malformed response must not abort the whole pass and
        // discard every resource already hydrated; it fails on its own.
        await input.onFailure?.({
          error,
          reason:
            error instanceof ExternalResourcePolicyError
              ? "policy-denied"
              : "retrieval-failed",
          url,
        });
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
  return {
    entries: entries.sort((left, right) => left.url.localeCompare(right.url)),
    version: externalResourceManifestVersion,
  };
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  url: string,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(
            new Error(
              `External resource ${url} did not respond within ${timeoutMs}ms.`,
            ),
          );
        }, timeoutMs);
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
  const uniqueEntries = [
    ...new Map(
      input.manifest.entries.map((entry) => [entry.relativePath, entry]),
    ).values(),
  ];
  for (const entry of uniqueEntries) {
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
  signal = new AbortController().signal,
): Promise<ExternalResourceFetchResult> {
  return await requestExternalResource(new URL(url), 0, signal);
}

async function requestExternalResource(
  url: URL,
  redirects: number,
  signal: AbortSignal,
): Promise<ExternalResourceFetchResult> {
  if (signal.aborted) {
    throw new Error(`External resource ${url.href} was cancelled.`);
  }
  if (!isCredentialFreeResourceUrl(url.href)) {
    throw new ExternalResourcePolicyError(
      "External resources require a named public HTTPS destination.",
    );
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const address = selectExternalResourceDestinationAddress(addresses);
  if (signal.aborted) {
    throw new Error(`External resource ${url.href} was cancelled.`);
  }

  return await new Promise<ExternalResourceFetchResult>((resolve, reject) => {
    const outbound = request(
      url,
      {
        headers: {
          accept: "*/*",
          "accept-encoding": "identity",
          "user-agent": "MakeADemo-External-Resource-Hydrator/1",
        },
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [address]);
            return;
          }
          callback(null, address.address, address.family);
        },
      },
      (response) => {
        response.on("error", reject);
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location !== undefined) {
          response.resume();
          if (redirects >= maximumRedirects) {
            reject(new Error("External resource exceeded the redirect limit."));
            return;
          }
          requestExternalResource(
            new URL(location, url),
            redirects + 1,
            signal,
          ).then(resolve, reject);
          return;
        }
        const contentLength = Number(response.headers["content-length"]);
        if (
          Number.isFinite(contentLength) &&
          contentLength > maximumResourceBytes
        ) {
          response.destroy(
            new Error("External resource exceeded the 128 MiB limit."),
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
          const contentEncoding = response.headers["content-encoding"];
          if (contentEncoding !== undefined && contentEncoding !== "identity") {
            reject(
              new Error(
                `External resource returned unsupported Content-Encoding ${contentEncoding}.`,
              ),
            );
            return;
          }
          resolve({
            body: Buffer.concat(chunks),
            // Hydration normalizes and validates Content-Type once for every
            // fetcher through normalizeContentType; a missing header still
            // rejects there with the same message.
            contentType: response.headers["content-type"] ?? "",
            finalUrl: url.href,
            headers: readReplayHeaders(response.headers),
            status,
          });
        });
      },
    );
    const abortRequest = () => {
      outbound.destroy(
        new Error(`External resource ${url.href} was cancelled.`),
      );
    };
    signal.addEventListener("abort", abortRequest, { once: true });
    outbound.once("close", () => {
      signal.removeEventListener("abort", abortRequest);
    });
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

/**
 * Selects a preferred DNS answer only when every resolved address is public.
 * Mixed public/private answers are rejected to keep redirects and rebinding
 * from crossing the controller's private-network boundary.
 */
export function selectExternalResourceDestinationAddress<
  T extends { address: string; family: number },
>(addresses: readonly T[]): T {
  const address =
    addresses.find(
      (candidate) => candidate.family === 4 && isPublicIp(candidate.address),
    ) ?? addresses.find((candidate) => isPublicIp(candidate.address));
  if (
    address === undefined ||
    addresses.some((candidate) => !isPublicIp(candidate.address))
  ) {
    throw new ExternalResourcePolicyError(
      "External resources require a public HTTPS destination.",
    );
  }
  return address;
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
            : resourceType === "fetch" || resourceType === "xhr"
              ? /^(?:audio\/|font\/|image\/|video\/|text\/css$|application\/(?:font|vnd\.ms-fontobject))/.test(
                  value,
                )
              : false;
  if (!compatible) {
    const ErrorType =
      resourceType === "fetch" || resourceType === "xhr"
        ? ExternalResourcePolicyError
        : Error;
    throw new ErrorType(
      `External ${resourceType ?? "unknown"} resource returned incompatible Content-Type ${contentType}.`,
    );
  }
}

function normalizeContentType(value: string): string {
  const contentType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (contentType.length === 0) {
    throw new Error("External resource response omitted Content-Type.");
  }
  return contentType;
}

function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublicAddresses.check(address, "ipv4");
  if (family === 6) return !nonPublicAddresses.check(address, "ipv6");
  return false;
}

function createNonPublicAddressBlockList(): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    blockList.addSubnet(address, prefix, "ipv4");
  }
  for (const [address, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ] as const) {
    blockList.addSubnet(address, prefix, "ipv6");
  }
  return blockList;
}
