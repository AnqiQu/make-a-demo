import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_NODE_LINE,
  SUPPORTED_NODE_LINES,
} from "../../src/server/agent-harness/tools/node-line-resolution";

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
    // compiler toolchain on disk, and headers must come from the active
    // /usr/local node so compiles always match the runtime ABI — including
    // after a node-line swap (ghost's NODE_MODULE_VERSION 137-vs-127 crash).
    const dockerfile = await readFile(
      join(import.meta.dirname, "submitted-code-node-browser.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("build-essential");
    expect(dockerfile).toContain("python3");
    expect(dockerfile).toContain("npm_config_nodedir=/usr/local");
    expect(dockerfile).not.toContain("node-gyp install");
  });

  it("bakes every supported node line for backend line swaps", async () => {
    // The backend swaps /usr/local wholesale to the repository's pinned
    // line (N78); every line must ship as a checksum-verified tarball and
    // the baked list must match SUPPORTED_NODE_LINES so the resolver and
    // the image cannot drift.
    const dockerfile = await readFile(
      join(import.meta.dirname, "submitted-code-node-browser.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain(
      `ARG MAKEADEMO_NODE_LINES="${SUPPORTED_NODE_LINES.join(" ")}"`,
    );
    expect(dockerfile).toContain(
      `ARG MAKEADEMO_DEFAULT_NODE_LINE="${DEFAULT_NODE_LINE}"`,
    );
    expect(dockerfile).toContain("/opt/node-lines");
    expect(dockerfile).toContain("SHASUMS256.txt");
    expect(dockerfile).toContain("sha256sum -c");
    expect(dockerfile).toContain("/usr/local/.makeademo-node-line");
    expect(dockerfile).toContain("rm -rf /usr/include/node");
  });

  it("keeps harness tooling outside the swappable node prefix", async () => {
    // A line swap replaces /usr/local/lib/node_modules; the capture stack
    // must live in its own prefix or the swap deletes it.
    const dockerfile = await readFile(
      join(import.meta.dirname, "submitted-code-node-browser.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("--prefix /opt/makeademo-tools");
    expect(dockerfile).toContain(
      "MAKEADEMO_TOOLS_NODE_MODULES=/opt/makeademo-tools/lib/node_modules",
    );
    expect(dockerfile).toContain("/opt/makeademo-tools/bin");
  });

  it("provisions package managers through corepack with a swap-surviving cache", async () => {
    // Pinned "packageManager" fields must resolve exactly (outline's
    // yarn@4.11.0, 2026-08-08 matrix) and the default managers must work
    // offline after any swap, so the corepack cache lives outside
    // /usr/local.
    const dockerfile = await readFile(
      join(import.meta.dirname, "submitted-code-node-browser.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("corepack enable");
    expect(dockerfile).toContain(
      "corepack install -g yarn@1.22.22 pnpm@10.12.1",
    );
    expect(dockerfile).toContain("COREPACK_HOME=/opt/corepack-cache");
    expect(dockerfile).toContain("COREPACK_ENABLE_DOWNLOAD_PROMPT=0");
    expect(dockerfile).not.toContain("npm install -g --force pnpm");
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
