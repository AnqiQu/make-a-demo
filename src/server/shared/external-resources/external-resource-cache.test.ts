import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeExternalResourcePassthrough,
  fetchExternalResource,
  hydrateExternalResourceCache,
  verifyExternalResourceCache,
} from "./external-resource-cache";
import { readExternalResourceManifest } from "./external-resource-manifest.schema";

describe("hydrateExternalResourceCache", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("authorizes exact credential-free resource URLs only after public DNS resolution", async () => {
    const failures: string[] = [];
    const resolvedHosts: string[] = [];
    const plan = await authorizeExternalResourcePassthrough({
      attempts: [
        {
          direction: "outbound",
          hasCredentials: false,
          host: "assets.example.com",
          method: "GET",
          phase: "browser",
          resourceType: "image",
          url: "https://assets.example.com/product.png",
        },
        {
          direction: "outbound",
          hasCredentials: false,
          host: "assets.example.com",
          method: "GET",
          phase: "browser",
          resourceType: "stylesheet",
          url: "https://assets.example.com/product.css",
        },
        {
          direction: "outbound",
          hasCredentials: false,
          host: "internal.example.com",
          method: "GET",
          phase: "browser",
          resourceType: "image",
          url: "https://internal.example.com/secret.png",
        },
        {
          direction: "outbound",
          hasCredentials: false,
          host: "assets.example.com",
          method: "GET",
          phase: "browser",
          resourceType: "image",
          url: "https://user:pass@assets.example.com/private.png",
        },
      ],
      onFailure: ({ url }) => {
        failures.push(url);
      },
      resolveHost: async (host) => {
        resolvedHosts.push(host);
        return host === "assets.example.com"
          ? ["93.184.216.34"]
          : ["127.0.0.1"];
      },
    });

    expect(plan).toEqual({
      attempts: [
        expect.objectContaining({
          url: "https://assets.example.com/product.png",
        }),
        expect.objectContaining({
          url: "https://assets.example.com/product.css",
        }),
      ],
      hosts: ["assets.example.com"],
      urls: [
        "https://assets.example.com/product.css",
        "https://assets.example.com/product.png",
      ],
    });
    expect(failures).toEqual([
      "https://internal.example.com/secret.png",
      "https://user:pass@assets.example.com/private.png",
    ]);
    expect(resolvedHosts).toEqual([
      "assets.example.com",
      "internal.example.com",
    ]);
  });

  it("stores an eligible browser resource once under its content hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-resources-"));
    directories.push(directory);
    const requestedUrls: string[] = [];

    const manifest = await hydrateExternalResourceCache({
      attempts: [
        {
          direction: "outbound",
          host: "assets.example.com",
          method: "GET",
          phase: "browser",
          resourceType: "image",
          url: "https://assets.example.com/product.png",
        },
        {
          direction: "outbound",
          host: "assets.example.com",
          method: "GET",
          phase: "browser",
          resourceType: "image",
          url: "https://assets.example.com/product.png",
        },
        {
          direction: "outbound",
          hasCredentials: true,
          host: "api.example.com",
          method: "GET",
          phase: "browser",
          resourceType: "fetch",
          url: "https://api.example.com/account",
        },
      ],
      directory,
      fetchResource: async (url) => {
        requestedUrls.push(url);
        return {
          body: new TextEncoder().encode("original-product-image"),
          contentType: "image/png",
          headers: {
            "access-control-allow-origin": "https://product.example.com",
            "set-cookie": "session=secret",
          },
          status: 200,
        };
      },
    });

    expect(requestedUrls).toEqual(["https://assets.example.com/product.png"]);
    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("Expected one cached resource.");
    expect(entry).toMatchObject({
      contentType: "image/png",
      sha256:
        "sha256:8a23ab32d82b186c8dcdf2181141b2f2c1bfb86ddead17163d34acf7858a4879",
      sizeBytes: 22,
      url: "https://assets.example.com/product.png",
    });
    expect(entry.headers["access-control-allow-origin"]).toBe("*");
    expect(entry.headers["set-cookie"]).toBeUndefined();
    expect(await readFile(join(directory, entry.relativePath), "utf8")).toBe(
      "original-product-image",
    );
  });

  it("bounds a stalled resource fetch without failing the hydration pass", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-resources-"));
    directories.push(directory);
    const failures: string[] = [];

    const manifest = await hydrateExternalResourceCache({
      attempts: [
        {
          direction: "outbound",
          host: "assets.example.com",
          method: "GET",
          phase: "browser",
          resourceType: "image",
          url: "https://assets.example.com/stalled.png",
        },
      ],
      directory,
      fetchResource: async () => await new Promise(() => undefined),
      onFailure: ({ error }) => {
        failures.push(String(error));
      },
      requestTimeoutMs: 5,
    });

    expect(manifest.entries).toEqual([]);
    expect(failures).toEqual([
      expect.stringContaining("did not respond within 5ms"),
    ]);
  });

  it("rejects private destinations before fetching resource bytes", async () => {
    await expect(
      fetchExternalResource("https://127.0.0.1/internal.png"),
    ).rejects.toThrow("public HTTPS destination");
  });

  it("rejects replay bytes that no longer match their manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-resources-"));
    directories.push(directory);
    const manifest = await hydrateExternalResourceCache({
      attempts: [
        {
          direction: "outbound",
          host: "assets.example.com",
          method: "GET",
          phase: "browser",
          resourceType: "image",
          url: "https://assets.example.com/product.png",
        },
      ],
      directory,
      fetchResource: async () => ({
        body: new TextEncoder().encode("original"),
        contentType: "image/png",
        headers: {},
        status: 200,
      }),
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
        version: "2026-07-14",
      }),
    ).toThrow("relativePath is invalid");
  });
});
