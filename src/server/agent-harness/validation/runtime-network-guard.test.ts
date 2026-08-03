import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createRuntimeNetworkGuardSource,
  readRuntimeNetworkAttempts,
  runtimeNetworkMarker,
} from "./runtime-network-guard";

const execFileAsync = promisify(execFile);

describe("runtime network guard", () => {
  it("blocks and reports server-side fetch before the process reaches the network", async () => {
    const { stderr } = await runBlockedGuarded(
      'fetch("https://api.example.com/data")',
    );

    expect(stderr).toContain(runtimeNetworkMarker);
    expect(readRuntimeNetworkAttempts(stderr)).toEqual([
      {
        direction: "outbound",
        hasCredentials: false,
        host: "api.example.com",
        method: "GET",
        phase: "runtime",
        resourceType: "fetch",
        url: "https://api.example.com/data",
      },
    ]);
  });

  it("refuses network evidence the app printed itself without the run's marker", () => {
    const forged = [
      `[makeademo:network-blocked] ${JSON.stringify({
        direction: "outbound",
        host: "attacker.example",
        phase: "runtime",
        resourceType: "image",
        url: "https://attacker.example/beacon.png",
      })}`,
      `noise [makeademo:network-blocked] ${JSON.stringify({
        direction: "outbound",
        host: "attacker.example",
        phase: "runtime",
      })}`,
    ].join("\n");

    expect(readRuntimeNetworkAttempts(forged)).toEqual([]);
  });

  it("redacts URL credentials from blocked runtime evidence", async () => {
    const { stderr } = await runBlockedGuarded(
      'fetch("https://user:pass@api.example.com/data?X-Amz-Signature=secret&width=200")',
    );

    expect(stderr).not.toContain("user:pass");
    expect(stderr).not.toContain("Signature=secret");
    expect(readRuntimeNetworkAttempts(stderr)).toMatchObject([
      {
        hasCredentials: true,
        url: "https://api.example.com/data?X-Amz-Signature=REDACTED&width=200",
      },
    ]);
  });

  it("does not treat loopback-looking domain names as local", async () => {
    const { stderr } = await runBlockedGuarded(
      'const socket = require("node:net").connect({ host: "127.example.invalid", port: 1 }); socket.destroy();',
    );

    expect(stderr).toContain(runtimeNetworkMarker);
    expect(readRuntimeNetworkAttempts(stderr)).toMatchObject([
      { host: "127.example.invalid", phase: "runtime" },
    ]);
  });

  it("replays an exact cached server-side fetch without opening the network", async () => {
    const fixture = await cachedGuardFixture(
      "https://assets.example.com/logo.svg",
      "original-logo",
    );

    try {
      const { stderr, stdout } = await execFileAsync(
        process.execPath,
        [
          "-e",
          'fetch("https://assets.example.com/logo.svg").then(async (response) => process.stdout.write(`${response.status}:${await response.text()}`))',
        ],
        {
          env: {
            ...process.env,
            ...fixture.env,
          },
        },
      );

      expect(stdout).toBe("200:original-logo");
      expect(stderr).not.toContain(runtimeNetworkMarker);
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });

  it("replays an exact cached server-side https request without opening the network", async () => {
    const fixture = await cachedGuardFixture(
      "https://assets.example.com/logo.svg",
      "original-logo",
    );

    try {
      const { stderr, stdout } = await execFileAsync(
        process.execPath,
        [
          "-e",
          'require("node:https").get("https://assets.example.com/logo.svg", (response) => { let body = ""; response.on("data", (chunk) => body += chunk); response.on("end", () => process.stdout.write(`${response.statusCode}:${body}`)); })',
        ],
        { env: { ...process.env, ...fixture.env } },
      );

      expect(stdout).toBe("200:original-logo");
      expect(stderr).not.toContain(runtimeNetworkMarker);
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });

  it("blocks a cached https request when credentials are added after creation", async () => {
    const fixture = await cachedGuardFixture(
      "https://assets.example.com/logo.svg",
      "original-logo",
    );

    try {
      const { stderr, stdout } = await execFileAsync(
        process.execPath,
        [
          "-e",
          'const request = require("node:https").request("https://assets.example.com/logo.svg", () => process.stdout.write("replayed")); request.on("error", () => {}); request.setHeader("authorization", "Bearer secret"); request.end();',
        ],
        { env: { ...process.env, ...fixture.env } },
      );

      expect(stdout).toBe("");
      expect(readRuntimeNetworkAttempts(stderr)).toMatchObject([
        { hasCredentials: true, url: "https://assets.example.com/logo.svg" },
      ]);
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  });
});

async function runBlockedGuarded(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "makeademo-network-guard-"));
  const guardPath = join(directory, "guard.cjs");
  await writeFile(guardPath, createRuntimeNetworkGuardSource());
  try {
    await execFileAsync(process.execPath, ["-e", source], {
      env: { ...process.env, NODE_OPTIONS: `--require=${guardPath}` },
    });
    throw new Error("Expected the runtime network guard to block the command.");
  } catch (error) {
    return {
      stderr: String(
        (error as { stderr?: string | Buffer }).stderr?.toString() ?? "",
      ),
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function cachedGuardFixture(
  url: string,
  contents: string,
): Promise<{
  directory: string;
  env: Record<string, string>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "makeademo-network-guard-"));
  const guardPath = join(directory, "guard.cjs");
  const cacheRoot = join(directory, "external-resources");
  const body = Buffer.from(contents);
  const digest = createHash("sha256").update(body).digest("hex");
  const relativePath = `resources/${digest}`;
  const manifestPath = join(cacheRoot, "external-resource-manifest.json");
  await mkdir(join(cacheRoot, "resources"), { recursive: true });
  await Promise.all([
    writeFile(guardPath, createRuntimeNetworkGuardSource()),
    writeFile(join(cacheRoot, relativePath), body),
    writeFile(
      manifestPath,
      JSON.stringify({
        entries: [
          {
            contentType: "image/svg+xml",
            headers: { "access-control-allow-origin": "*" },
            relativePath,
            sha256: `sha256:${digest}`,
            sizeBytes: body.byteLength,
            status: 200,
            url,
          },
        ],
        version: "2026-07-15",
      }),
    ),
  ]);
  return {
    directory,
    env: {
      MAKEADEMO_EXTERNAL_RESOURCE_MANIFEST: manifestPath,
      MAKEADEMO_EXTERNAL_RESOURCE_ROOT: cacheRoot,
      NODE_OPTIONS: `--require=${guardPath}`,
    },
  };
}
