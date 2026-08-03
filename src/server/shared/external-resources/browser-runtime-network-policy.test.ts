import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserRuntimeNetworkPolicySource } from "./browser-runtime-network-policy";

describe("createBrowserRuntimeNetworkPolicySource", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("blocks every uncached external request", async () => {
    const { handle, result } = await policyHarness({ mode: "exploration" });

    const safe = fakeRoute("https://assets.example.com/dashboard.png");
    await handle(safe);
    expect(safe.aborted).toBe(true);

    const credentialed = fakeRoute("https://assets.example.com/dashboard.png", {
      cookie: "session=secret",
    });
    await handle(credentialed);
    expect(credentialed.aborted).toBe(true);

    const apiKey = fakeRoute("https://assets.example.com/dashboard.png", {
      "x-api-key": "secret",
    });
    await handle(apiKey);
    expect(apiKey.aborted).toBe(true);

    const userInfo = fakeRoute(
      "https://user:pass@assets.example.com/dashboard.png",
    );
    await handle(userInfo);
    expect(userInfo.aborted).toBe(true);
    expect(result.blockedNetworkAttempts[3]).toMatchObject({
      hasCredentials: true,
      url: "https://assets.example.com/dashboard.png",
    });

    const signed = fakeRoute(
      "https://assets.example.com/private.png?X-Amz-Signature=secret&width=200",
    );
    await handle(signed);
    expect(signed.aborted).toBe(true);
    expect(result.blockedNetworkAttempts[4]).toMatchObject({
      hasCredentials: true,
      url: "https://assets.example.com/private.png?X-Amz-Signature=REDACTED&width=200",
    });

    const unapproved = fakeRoute("https://assets.example.com/other.png");
    await handle(unapproved);
    expect(unapproved.aborted).toBe(true);

    const loopbackLookalike = fakeRoute("https://127.example.com/logo.png");
    await handle(loopbackLookalike);
    expect(loopbackLookalike.aborted).toBe(true);

    const ipv6Loopback = fakeRoute("http://[::1]:3000/logo.png");
    await handle(ipv6Loopback);
    expect(ipv6Loopback.continued).toBe(true);
    expect(result.blockedNetworkAttempts).toHaveLength(7);
  });

  it("refuses to replay bytes that no longer match the manifest digest", async () => {
    const replayRoot = await mkdtemp(join(tmpdir(), "makeademo-replay-"));
    directories.push(replayRoot);
    const body = Buffer.from("original-logo");
    const digest = createHash("sha256").update(body).digest("hex");
    await mkdir(join(replayRoot, "resources"));
    await writeFile(join(replayRoot, "resources", digest), "tampered-logo");
    const { handle, result } = await policyHarness({
      manifest: {
        entries: [
          {
            contentType: "image/png",
            headers: {},
            relativePath: `resources/${digest}`,
            sha256: `sha256:${digest}`,
            sizeBytes: body.byteLength,
            status: 200,
            url: "https://assets.example.com/logo.png",
          },
        ],
        version: "2026-07-15",
      },
      mode: "exploration",
      replayRoot,
    });

    const tampered = fakeRoute("https://assets.example.com/logo.png");
    await handle(tampered);

    expect(tampered.fulfilled).toBeUndefined();
    expect(tampered.aborted).toBe(true);
    expect(result.blockedNetworkAttempts).toHaveLength(1);
  });

  it("marks replayed responses no-sniff so a cached type cannot be reinterpreted", async () => {
    const replayRoot = await mkdtemp(join(tmpdir(), "makeademo-replay-"));
    directories.push(replayRoot);
    const body = Buffer.from("original-logo");
    const digest = createHash("sha256").update(body).digest("hex");
    await mkdir(join(replayRoot, "resources"));
    await writeFile(join(replayRoot, "resources", digest), body);
    const { handle } = await policyHarness({
      manifest: {
        entries: [
          {
            contentType: "image/png",
            headers: {},
            relativePath: `resources/${digest}`,
            sha256: `sha256:${digest}`,
            sizeBytes: body.byteLength,
            status: 200,
            url: "https://assets.example.com/logo.png",
          },
        ],
        version: "2026-07-15",
      },
      mode: "exploration",
      replayRoot,
    });

    const replayed = fakeRoute("https://assets.example.com/logo.png");
    await handle(replayed);

    expect(replayed.fulfilled).toMatchObject({
      contentType: "image/png",
      headers: { "x-content-type-options": "nosniff" },
      status: 200,
    });
  });

  it("replays cached media byte ranges locally", async () => {
    const replayRoot = await mkdtemp(join(tmpdir(), "makeademo-replay-"));
    directories.push(replayRoot);
    const mediaBody = Buffer.from("0123456789");
    const digest = createHash("sha256").update(mediaBody).digest("hex");
    await mkdir(join(replayRoot, "resources"));
    await writeFile(join(replayRoot, "resources", digest), mediaBody);
    const { handle, result } = await policyHarness({
      manifest: {
        entries: [
          {
            contentType: "video/mp4",
            headers: {},
            relativePath: `resources/${digest}`,
            sha256: `sha256:${digest}`,
            sizeBytes: 10,
            status: 200,
            url: "https://assets.example.com/demo.mp4",
          },
        ],
        version: "2026-07-15",
      },
      mode: "exploration",
      replayRoot,
    });

    const range = fakeRoute("https://assets.example.com/demo.mp4", {
      range: "bytes=2-5",
    });
    await handle(range);

    expect(range.fulfilled).toMatchObject({
      headers: {
        "accept-ranges": "bytes",
        "content-length": "4",
        "content-range": "bytes 2-5/10",
      },
      status: 206,
    });
    expect(Buffer.from(range.fulfilled?.body as Uint8Array).toString()).toBe(
      "2345",
    );
    expect(result.blockedNetworkAttempts).toEqual([]);
  });

  it("replays a cached redirect and final response entirely locally", async () => {
    const replayRoot = await mkdtemp(join(tmpdir(), "makeademo-replay-"));
    directories.push(replayRoot);
    const themeBody = Buffer.from("body{color:red}");
    const digest = createHash("sha256").update(themeBody).digest("hex");
    await mkdir(join(replayRoot, "resources"));
    await writeFile(join(replayRoot, "resources", digest), themeBody);
    const { handle, result } = await policyHarness({
      manifest: {
        entries: [
          {
            contentType: "text/css",
            headers: {},
            relativePath: `resources/${digest}`,
            responseUrl: "https://cdn.example.com/v2/theme.css",
            sha256: `sha256:${digest}`,
            sizeBytes: themeBody.byteLength,
            status: 200,
            url: "https://assets.example.com/theme.css",
          },
        ],
        version: "2026-07-15",
      },
      mode: "exploration",
      replayRoot,
    });

    const original = fakeRoute("https://assets.example.com/theme.css");
    await handle(original);
    expect(original.fulfilled).toMatchObject({
      headers: { location: "https://cdn.example.com/v2/theme.css" },
      status: 307,
    });

    const redirected = fakeRoute("https://cdn.example.com/v2/theme.css");
    await handle(redirected);
    expect(redirected.fulfilled).toMatchObject({
      contentType: "text/css",
      status: 200,
    });
    expect(result.blockedNetworkAttempts).toEqual([]);
  });

  it("replays cached URLs only for credential-free GET requests", async () => {
    const digest = "0".repeat(64);
    const { handle, result } = await policyHarness({
      manifest: {
        entries: [
          {
            contentType: "image/png",
            headers: {},
            relativePath: `resources/${digest}`,
            sha256: `sha256:${digest}`,
            sizeBytes: 10,
            status: 200,
            url: "https://assets.example.com/logo.png",
          },
        ],
        version: "2026-07-15",
      },
      mode: "exploration",
    });

    const credentialed = fakeRoute("https://assets.example.com/logo.png", {
      authorization: "Bearer secret",
    });
    await handle(credentialed);

    expect(credentialed.aborted).toBe(true);
    expect(credentialed.fulfilled).toBeUndefined();
    const mutation = fakeRoute(
      "https://assets.example.com/logo.png",
      {},
      "POST",
    );
    await handle(mutation);
    expect(mutation.aborted).toBe(true);
    expect(mutation.fulfilled).toBeUndefined();
    expect(result.blockedNetworkAttempts).toMatchObject([
      { hasCredentials: true },
      { method: "POST" },
    ]);
  });
});

type FakeRoute = ReturnType<typeof fakeRoute>;

async function policyHarness(
  input: Parameters<typeof createBrowserRuntimeNetworkPolicySource>[0],
) {
  let routeHandler: ((route: FakeRoute) => Promise<void>) | undefined;
  const context = {
    async route(
      _pattern: string,
      handler: (route: FakeRoute) => Promise<void>,
    ) {
      routeHandler = handler;
    },
    async routeWebSocket() {},
  };
  const result = { blockedNetworkAttempts: [] as unknown[] };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined)
    .constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<void>;
  const installPolicy = new AsyncFunction(
    "context",
    "baseUrl",
    "result",
    "makeADemoReadReplayFile",
    "makeADemoCreateHash",
    createBrowserRuntimeNetworkPolicySource(input),
  );
  await installPolicy(
    context,
    "http://127.0.0.1:3000",
    result,
    readFile,
    createHash,
  );
  if (routeHandler === undefined) throw new Error("Policy route was not set.");
  return { handle: routeHandler, result };
}

function fakeRoute(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
) {
  return {
    aborted: false,
    continued: false,
    fulfilled: undefined as Record<string, unknown> | undefined,
    async abort() {
      this.aborted = true;
    },
    async continue() {
      this.continued = true;
    },
    async fulfill(options: Record<string, unknown>) {
      this.fulfilled = options;
    },
    request() {
      return {
        async allHeaders() {
          return headers;
        },
        frame() {
          return { url: () => "http://127.0.0.1:3000/" };
        },
        method: () => method,
        resourceType: () => "image",
        url: () => url,
      };
    },
  };
}
