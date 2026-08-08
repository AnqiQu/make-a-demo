import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Daytona OpenCode prepared image", () => {
  it("includes Docker-in-Docker support and the submitted-code image definition", async () => {
    const dockerfile = await readFile(
      join(import.meta.dirname, "opencode.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("docker.io");
    expect(dockerfile).toContain("ca-certificates");
    expect(dockerfile).toContain("git");
    expect(dockerfile).toContain("update-ca-certificates");
    expect(dockerfile).toContain("submitted-code-node-browser.Dockerfile");
    expect(dockerfile).toContain("makeademo-preload-submitted-code-image");
    expect(dockerfile).toContain(
      "GIT_SSL_CAINFO=/etc/openshell-tls/ca-bundle.pem",
    );
    expect(dockerfile).toContain("ln -s /etc/ssl/certs/ca-certificates.crt");
    expect(dockerfile).toContain("test -f /etc/openshell-tls/ca-bundle.pem");
    expect(dockerfile).toContain("bun-v1.3.14");
    expect(dockerfile).toContain(
      "git config --system http.sslCAInfo /etc/openshell-tls/ca-bundle.pem",
    );
  });

  it("pre-caches the offline native-build toolchain in the submitted-code image", async () => {
    // Sealed-network rebuilds compile native modules from source (ghost's
    // better-sqlite3, calcom's sqlite3, 2026-08-08 matrix): they need the
    // compiler toolchain and node-gyp's headers for this image's Node
    // version already on disk, because both downloads are impossible after
    // the install window reseals.
    const dockerfile = await readFile(
      join(import.meta.dirname, "submitted-code-node-browser.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("build-essential");
    expect(dockerfile).toContain("python3");
    expect(dockerfile).toContain("node-gyp install");
  });

  it("defines the generic Node/browser submitted-code runtime image", async () => {
    const dockerfile = await readFile(
      join(import.meta.dirname, "submitted-code-node-browser.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("mcr.microsoft.com/playwright");
    expect(dockerfile).toContain("ca-certificates");
    expect(dockerfile).toContain("ffmpeg");
    expect(dockerfile).toContain("git");
    expect(dockerfile).toContain("unzip");
    expect(dockerfile).toContain("update-ca-certificates");
    expect(dockerfile).toContain("bun-v1.3.14");
    expect(dockerfile).toContain("pnpm@10.12.1");
    expect(dockerfile).toContain("yarn@1.22.22");
    expect(dockerfile).toContain("mcr.microsoft.com/playwright:v1.60.0-noble");
    expect(dockerfile).toContain("@playwright/test@1.60.0");
    expect(dockerfile).toContain("playwright@1.60.0");
    expect(dockerfile).toContain("typescript@5.7.3");
    expect(dockerfile).toContain("WORKDIR /workspace");
  });
});
