import { describe, expect, it } from "vitest";

import { resolveNodeLine } from "./node-line-resolution";

function packageJson(contents: Record<string, unknown>): {
  path: string;
  text: string;
} {
  return { path: "package.json", text: JSON.stringify(contents) };
}

describe("resolveNodeLine", () => {
  it("selects the pinned major line from a bare engines.node pin", () => {
    const resolution = resolveNodeLine({
      files: [packageJson({ engines: { node: "22" } })],
    });

    expect(resolution.line).toBe(22);
    expect(resolution.satisfied).toBe(true);
    expect(resolution.provenance.join(" ")).toContain("engines.node");
  });

  it("honors an exact devEngines runtime pin (ghost shape)", () => {
    const resolution = resolveNodeLine({
      files: [
        packageJson({
          devEngines: {
            runtime: { name: "node", onFail: "download", version: "22.23.1" },
          },
          engines: { node: "^22.23.1" },
        }),
      ],
    });

    expect(resolution.line).toBe(22);
    expect(resolution.satisfied).toBe(true);
  });

  it("keeps the current default line for a ^24 pin (twenty shape)", () => {
    const resolution = resolveNodeLine({
      files: [
        packageJson({ engines: { node: "^24.5.0" } }),
        { path: ".nvmrc", text: "24.16.0\n" },
      ],
    });

    expect(resolution.line).toBe(24);
    expect(resolution.satisfied).toBe(true);
  });

  it("resolves an open range to the highest supported line", () => {
    const resolution = resolveNodeLine({
      files: [packageJson({ engines: { node: ">=22.18.0" } })],
    });

    expect(resolution.line).toBe(24);
    expect(resolution.satisfied).toBe(true);
  });

  it("defaults when the repository declares no Node pin", () => {
    const resolution = resolveNodeLine({
      files: [packageJson({ name: "unpinned" })],
    });

    expect(resolution.line).toBe(24);
    expect(resolution.satisfied).toBe(true);
    expect(resolution.provenance).toEqual(["default (no repository Node pin)"]);
  });

  it("picks the nearest supported line for an unsupported pin and flags it", () => {
    const resolution = resolveNodeLine({
      files: [packageJson({ engines: { node: "18" } })],
    });

    expect(resolution.line).toBe(20);
    expect(resolution.satisfied).toBe(false);
  });

  it("refines a root range with the locked target directory's pin", () => {
    const resolution = resolveNodeLine({
      files: [
        packageJson({ engines: { node: ">=20" } }),
        { path: "apps/web/.nvmrc", text: "v22.11.0" },
      ],
      targetId: "apps/web",
    });

    expect(resolution.line).toBe(22);
    expect(resolution.satisfied).toBe(true);
  });

  it("lets the root's install-governing pin win a root/target conflict", () => {
    const resolution = resolveNodeLine({
      files: [
        packageJson({ engines: { node: "22" } }),
        {
          path: "apps/web/package.json",
          text: JSON.stringify({ engines: { node: "^24.0.0" } }),
        },
      ],
      targetId: "apps/web",
    });

    expect(resolution.line).toBe(22);
    expect(resolution.satisfied).toBe(false);
  });

  it("skips unparseable pins instead of failing resolution", () => {
    const resolution = resolveNodeLine({
      files: [
        packageJson({ engines: { node: "please-use-a-modern-node" } }),
        { path: ".nvmrc", text: "lts/iron" },
      ],
    });

    expect(resolution.line).toBe(24);
    expect(resolution.satisfied).toBe(true);
  });
});
