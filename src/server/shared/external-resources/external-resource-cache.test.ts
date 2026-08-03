import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkAttempt } from "../../agent-harness/schemas/artifacts";
import {
  fetchExternalResource,
  hydrateExternalResourceCache,
  selectExternalResourceDestinationAddress,
  verifyExternalResourceCache,
} from "./external-resource-cache";
import { readExternalResourceManifest } from "./external-resource-manifest.schema";

const externalResourceRequestMock = vi.hoisted(() => ({
  address: { address: "93.184.216.34", family: 4 },
  // Location headers the fake server returns, one per request in order.
  locations: [] as Array<string | undefined>,
  lookupAll: true,
  lookupFamily: undefined as number | undefined,
  lookupResult: undefined as
    | string
    | Array<{ address: string; family: number }>
    | undefined,
}));

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) => [
    hostname === "localhost"
      ? { address: "127.0.0.1", family: 4 }
      : externalResourceRequestMock.address,
  ]),
}));

vi.mock("node:https", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    request: vi.fn(
      (
        _url: URL,
        options: {
          lookup: (
            hostname: string,
            options: { all: boolean },
            callback: (
              error: Error | null,
              result: string | Array<{ address: string; family: number }>,
              family?: number,
            ) => void,
          ) => void;
        },
        onResponse: (response: InstanceType<typeof EventEmitter>) => void,
      ) => {
        const outbound = Object.assign(new EventEmitter(), {
          destroy(error?: Error) {
            if (error !== undefined) {
              queueMicrotask(() => outbound.emit("error", error));
            }
          },
          end() {
            options.lookup(
              "assets.example.com",
              { all: externalResourceRequestMock.lookupAll },
              (error, result, family) => {
                if (error !== null) {
                  outbound.emit("error", error);
                  return;
                }
                externalResourceRequestMock.lookupResult = result;
                externalResourceRequestMock.lookupFamily = family;
                const location = externalResourceRequestMock.locations.shift();
                const response = Object.assign(new EventEmitter(), {
                  headers:
                    location === undefined
                      ? { "content-type": "image/png" }
                      : { location },
                  resume() {},
                  statusCode: location === undefined ? 200 : 302,
                });
                onResponse(response);
                queueMicrotask(() => response.emit("end"));
              },
            );
          },
          setTimeout() {
            return outbound;
          },
        });
        return outbound;
      },
    ),
  };
});

describe("hydrateExternalResourceCache", () => {
  const directories: string[] = [];
  const createDirectory = async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-resources-"));
    directories.push(directory);
    return directory;
  };
  const resourceAttempt = (
    url: string,
    resourceType = "image",
    overrides: Partial<NetworkAttempt> = {},
  ): NetworkAttempt => ({
    direction: "outbound",
    host: new URL(url).host,
    method: "GET",
    phase: "browser",
    resourceType,
    url,
    ...overrides,
  });
  const response = (body: string, contentType: string) => ({
    body: new TextEncoder().encode(body),
    contentType,
    headers: {},
    status: 200,
  });

  beforeEach(() => {
    externalResourceRequestMock.locations = [];
    externalResourceRequestMock.lookupAll = true;
    externalResourceRequestMock.lookupFamily = undefined;
    externalResourceRequestMock.lookupResult = undefined;
  });

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("stores an eligible browser resource once under its content hash", async () => {
    const directory = await createDirectory();
    const requestedUrls: string[] = [];
    const productUrl = "https://assets.example.com/product.png";

    const manifest = await hydrateExternalResourceCache({
      attempts: [
        resourceAttempt(productUrl),
        resourceAttempt(productUrl),
        resourceAttempt("https://api.example.com/account", "fetch", {
          hasCredentials: true,
        }),
      ],
      directory,
      fetchResource: async (url) => {
        requestedUrls.push(url);
        return {
          ...response("original-product-image", "image/png"),
          headers: {
            "access-control-allow-origin": "https://product.example.com",
            "set-cookie": "session=secret",
          },
        };
      },
    });

    expect(requestedUrls).toEqual([productUrl]);
    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("Expected one cached resource.");
    expect(entry).toMatchObject({
      contentType: "image/png",
      sha256:
        "sha256:8a23ab32d82b186c8dcdf2181141b2f2c1bfb86ddead17163d34acf7858a4879",
      sizeBytes: 22,
      url: productUrl,
    });
    expect(entry.headers["access-control-allow-origin"]).toBe("*");
    expect(entry.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(entry.headers["set-cookie"]).toBeUndefined();
    expect(await readFile(join(directory, entry.relativePath), "utf8")).toBe(
      "original-product-image",
    );
  });

  it("orders the cache manifest deterministically by exact URL", async () => {
    const directory = await createDirectory();

    const manifest = await hydrateExternalResourceCache({
      attempts: [
        resourceAttempt("https://assets.example.com/z.png"),
        resourceAttempt("https://assets.example.com/a.png"),
      ],
      directory,
      fetchResource: async (url) => response(url, "image/png"),
    });

    expect(manifest.entries.map((entry) => entry.url)).toEqual([
      "https://assets.example.com/a.png",
      "https://assets.example.com/z.png",
    ]);
  });

  it("records the final response URL after safe controller redirects", async () => {
    const directory = await createDirectory();

    const manifest = await hydrateExternalResourceCache({
      attempts: [resourceAttempt("https://assets.example.com/logo")],
      directory,
      fetchResource: async () => ({
        ...response("logo", "image/svg+xml"),
        finalUrl: "https://cdn.example.com/v2/logo.svg",
      }),
    });

    expect(manifest.entries).toMatchObject([
      { responseUrl: "https://cdn.example.com/v2/logo.svg" },
    ]);
  });

  it("denies a redirect that lands on a private address even through an injected fetcher", async () => {
    const directory = await createDirectory();
    const failures: string[] = [];

    const manifest = await hydrateExternalResourceCache({
      attempts: [resourceAttempt("https://assets.example.com/logo.svg")],
      directory,
      fetchResource: async () => ({
        ...response("logo", "image/svg+xml"),
        finalUrl: "https://localhost/internal/logo.svg",
      }),
      onFailure: async ({ reason }) => {
        failures.push(reason);
      },
    });

    expect(manifest.entries).toEqual([]);
    expect(failures).toEqual(["policy-denied"]);
  });

  it("never requests a resource served from a non-standard port", async () => {
    const directory = await createDirectory();
    const requestedUrls: string[] = [];

    const manifest = await hydrateExternalResourceCache({
      attempts: [
        resourceAttempt("https://assets.example.com:6379/logo.svg"),
        resourceAttempt("https://assets.example.com:443/allowed.svg"),
      ],
      directory,
      fetchResource: async (url) => {
        requestedUrls.push(url);
        return response("logo", "image/svg+xml");
      },
    });

    expect(requestedUrls).toEqual([
      "https://assets.example.com:443/allowed.svg",
    ]);
    expect(manifest.entries.map((entry) => entry.url)).toEqual([
      "https://assets.example.com:443/allowed.svg",
    ]);
  });

  it("keeps hydrating other resources when one response is malformed", async () => {
    const directory = await createDirectory();
    const failures: string[] = [];

    const manifest = await hydrateExternalResourceCache({
      attempts: [
        resourceAttempt("https://assets.example.com/broken.svg"),
        resourceAttempt("https://assets.example.com/good.svg"),
      ],
      directory,
      fetchResource: async (url) =>
        url.includes("broken")
          ? ({
              ...response("logo", "image/svg+xml"),
              contentType: 42 as unknown as string,
            } as never)
          : response("logo", "image/svg+xml"),
      onFailure: async ({ reason }) => {
        failures.push(reason);
      },
    });

    expect(manifest.entries.map((entry) => entry.url)).toEqual([
      "https://assets.example.com/good.svg",
    ]);
    expect(failures).toEqual(["retrieval-failed"]);
  });

  it("never downloads executable browser scripts", async () => {
    const directory = await createDirectory();
    const requestedUrls: string[] = [];

    const manifest = await hydrateExternalResourceCache({
      attempts: [
        resourceAttempt("https://assets.example.com/runtime.js", "script"),
      ],
      directory,
      fetchResource: async (url) => {
        requestedUrls.push(url);
        return response("alert('remote code')", "application/javascript");
      },
    });

    expect(requestedUrls).toEqual([]);
    expect(manifest.entries).toEqual([]);
  });

  it("never downloads resources whose URL contains bearer credentials", async () => {
    const directory = await createDirectory();
    const requestedUrls: string[] = [];

    const manifest = await hydrateExternalResourceCache({
      attempts: [
        resourceAttempt(
          "https://assets.example.com/private.png?X-Amz-Signature=secret",
        ),
      ],
      directory,
      fetchResource: async (url) => {
        requestedUrls.push(url);
        return response("image", "image/png");
      },
    });

    expect(requestedUrls).toEqual([]);
    expect(manifest.entries).toEqual([]);
  });

  it("never downloads resource URLs addressed by raw IP", async () => {
    const directory = await createDirectory();
    const requestedUrls: string[] = [];

    const manifest = await hydrateExternalResourceCache({
      attempts: [resourceAttempt("https://93.184.216.34/logo.png")],
      directory,
      fetchResource: async (url) => {
        requestedUrls.push(url);
        return response("image", "image/png");
      },
    });

    expect(requestedUrls).toEqual([]);
    expect(manifest.entries).toEqual([]);
  });

  it("does not cache JSON API responses discovered through fetch", async () => {
    const directory = await createDirectory();
    const failures: string[] = [];

    const manifest = await hydrateExternalResourceCache({
      attempts: [resourceAttempt("https://api.example.com/dashboard", "fetch")],
      directory,
      fetchResource: async () =>
        response('{"private":"data"}', "application/json"),
      onFailure: ({ error }) => {
        failures.push(String(error));
      },
    });

    expect(manifest.entries).toEqual([]);
    expect(failures).toEqual([
      expect.stringContaining("incompatible Content-Type application/json"),
    ]);
  });

  it("normalizes safe response content types before replay", async () => {
    const directory = await createDirectory();

    const manifest = await hydrateExternalResourceCache({
      attempts: [
        resourceAttempt("https://fonts.example.com/family.css", "stylesheet"),
      ],
      directory,
      fetchResource: async () =>
        response("@font-face {}", "Text/CSS; charset=utf-8"),
    });

    expect(manifest.entries).toMatchObject([{ contentType: "text/css" }]);
  });

  it("bounds a stalled resource fetch without failing the hydration pass", async () => {
    const directory = await createDirectory();
    const failures: string[] = [];
    let requestAborted = false;

    const manifest = await hydrateExternalResourceCache({
      attempts: [resourceAttempt("https://assets.example.com/stalled.png")],
      directory,
      fetchResource: async (_url, signal) =>
        await new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              requestAborted = true;
              reject(new Error("request aborted"));
            },
            { once: true },
          );
        }),
      onFailure: ({ error }) => {
        failures.push(String(error));
      },
      requestTimeoutMs: 5,
    });

    expect(manifest.entries).toEqual([]);
    expect(requestAborted).toBe(true);
    expect(failures).toEqual([
      expect.stringContaining("did not respond within 5ms"),
    ]);
  });

  it("rejects private destinations before fetching resource bytes", async () => {
    await expect(
      fetchExternalResource("https://localhost/internal.png"),
    ).rejects.toThrow("public HTTPS destination");
  });

  it("rejects public raw-IP destinations before fetching resource bytes", async () => {
    await expect(
      fetchExternalResource("https://93.184.216.34/product.png"),
    ).rejects.toThrow("named public HTTPS destination");
  });

  it("refuses redirects that leave the public HTTPS surface", async () => {
    for (const [location, expected] of [
      ["https://localhost/internal.png", /public HTTPS destination/],
      ["http://assets.example.com/plain.png", /named public HTTPS destination/],
      ["https://93.184.216.34/product.png", /named public HTTPS destination/],
    ] as const) {
      externalResourceRequestMock.locations = [location];
      await expect(
        fetchExternalResource("https://assets.example.com/product.png"),
      ).rejects.toThrow(expected);
      expect(externalResourceRequestMock.locations).toEqual([]);
    }
  });

  it("refuses a redirect chain longer than the controller allows", async () => {
    externalResourceRequestMock.locations = Array.from(
      { length: 6 },
      (_value, index) => `https://assets.example.com/hop-${index}.png`,
    );

    await expect(
      fetchExternalResource("https://assets.example.com/product.png"),
    ).rejects.toThrow(/exceeded the redirect/i);
  });

  it("pins Bun HTTPS requests with an all-address DNS result", async () => {
    await fetchExternalResource("https://assets.example.com/product.png");

    expect(externalResourceRequestMock.lookupResult).toEqual([
      externalResourceRequestMock.address,
    ]);
    expect(externalResourceRequestMock.lookupFamily).toBeUndefined();
  });

  it("pins Node HTTPS requests with a scalar DNS result", async () => {
    externalResourceRequestMock.lookupAll = false;

    await fetchExternalResource("https://assets.example.com/product.png");

    expect(externalResourceRequestMock.lookupResult).toBe(
      externalResourceRequestMock.address.address,
    );
    expect(externalResourceRequestMock.lookupFamily).toBe(
      externalResourceRequestMock.address.family,
    );
  });

  it("rejects replay bytes that no longer match their manifest", async () => {
    const directory = await createDirectory();
    const manifest = await hydrateExternalResourceCache({
      attempts: [resourceAttempt("https://assets.example.com/product.png")],
      directory,
      fetchResource: async () => response("original", "image/png"),
    });
    const entry = manifest.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("Expected one cached resource.");
    await writeFile(join(directory, entry.relativePath), "tampered");

    await expect(
      verifyExternalResourceCache({ directory, manifest }),
    ).rejects.toThrow("cache integrity failed");
  });

  it("rejects cache paths that could escape the replay directory", () => {
    expect(() =>
      readExternalResourceManifest({
        entries: [
          {
            contentType: "image/png",
            headers: {},
            relativePath: "../../secret",
            sha256: `sha256:${"0".repeat(64)}`,
            sizeBytes: 1,
            status: 200,
            url: "https://assets.example.com/product.png",
          },
        ],
        version: "2026-07-15",
      }),
    ).toThrow("relativePath is invalid");
  });

  it("rejects unsafe response headers from persisted cache manifests", () => {
    expect(() =>
      readExternalResourceManifest({
        entries: [
          {
            contentType: "image/png",
            headers: { "set-cookie": "session=secret" },
            relativePath: `resources/${"0".repeat(64)}`,
            sha256: `sha256:${"0".repeat(64)}`,
            sizeBytes: 1,
            status: 200,
            url: "https://assets.example.com/product.png",
          },
        ],
        version: "2026-07-15",
      }),
    ).toThrow("header set-cookie is not replay-safe");
  });

  it("rejects duplicate exact URLs from persisted cache manifests", () => {
    const entry = {
      contentType: "image/png",
      headers: {},
      relativePath: `resources/${"0".repeat(64)}`,
      sha256: `sha256:${"0".repeat(64)}`,
      sizeBytes: 1,
      status: 200,
      url: "https://assets.example.com/product.png",
    };

    expect(() =>
      readExternalResourceManifest({
        entries: [entry, entry],
        version: "2026-07-15",
      }),
    ).toThrow("URL must be unique");
  });

  it("accepts distinct resource URLs that share one final CDN response", () => {
    const digest = "0".repeat(64);
    const shared = {
      contentType: "image/png",
      headers: {},
      relativePath: `resources/${digest}`,
      responseUrl: "https://cdn.example.com/assets/product.png",
      sha256: `sha256:${digest}`,
      sizeBytes: 1,
      status: 200,
    };

    expect(
      readExternalResourceManifest({
        entries: [
          { ...shared, url: "https://assets.example.com/product" },
          { ...shared, url: "https://images.example.com/product" },
        ],
        version: "2026-07-15",
      }).entries,
    ).toHaveLength(2);
  });

  it("rejects conflicting bytes for one final CDN response URL", () => {
    const firstDigest = "0".repeat(64);
    const secondDigest = "1".repeat(64);

    expect(() =>
      readExternalResourceManifest({
        entries: [
          {
            contentType: "image/png",
            headers: {},
            relativePath: `resources/${firstDigest}`,
            responseUrl: "https://cdn.example.com/assets/product.png",
            sha256: `sha256:${firstDigest}`,
            sizeBytes: 1,
            status: 200,
            url: "https://assets.example.com/product",
          },
          {
            contentType: "image/png",
            headers: {},
            relativePath: `resources/${secondDigest}`,
            responseUrl: "https://cdn.example.com/assets/product.png",
            sha256: `sha256:${secondDigest}`,
            sizeBytes: 1,
            status: 200,
            url: "https://images.example.com/product",
          },
        ],
        version: "2026-07-15",
      }),
    ).toThrow("conflicting replay responses");
  });
});

describe("selectExternalResourceDestinationAddress", () => {
  it("accepts an ordinary public IPv4 DNS answer", () => {
    expect(
      selectExternalResourceDestinationAddress([
        { address: "172.66.40.201", family: 4 },
      ]),
    ).toEqual({ address: "172.66.40.201", family: 4 });
  });
});
