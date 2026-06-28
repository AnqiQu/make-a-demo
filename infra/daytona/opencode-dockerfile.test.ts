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
    expect(dockerfile).toContain("submitted-code-node-browser.Dockerfile");
    expect(dockerfile).toContain("makeademo-preload-submitted-code-image");
  });

  it("defines the generic Node/browser submitted-code runtime image", async () => {
    const dockerfile = await readFile(
      join(import.meta.dirname, "submitted-code-node-browser.Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain("mcr.microsoft.com/playwright");
    expect(dockerfile).toContain("ffmpeg");
    expect(dockerfile).toContain("unzip");
    expect(dockerfile).toContain("bun-v1.2.5");
    expect(dockerfile).toContain("corepack enable");
    expect(dockerfile).toContain("@playwright/test@1.49.1");
    expect(dockerfile).toContain("playwright@1.49.1");
    expect(dockerfile).toContain("typescript@5.7.3");
    expect(dockerfile).toContain("WORKDIR /workspace");
  });
});
