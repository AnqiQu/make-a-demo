import { describe, expect, it } from "vitest";

import { inferInstallPlan } from "./install-plan";

describe("inferInstallPlan", () => {
  it("chooses the install command from JavaScript lockfiles", () => {
    expect(inferInstallPlan(["package.json", "bun.lock"])).toMatchObject({
      command: "bun install",
      packageManager: "bun",
      warnings: [],
    });

    expect(inferInstallPlan(["package.json", "pnpm-lock.yaml"])).toMatchObject({
      command: "pnpm install --frozen-lockfile",
      packageManager: "pnpm",
    });

    expect(inferInstallPlan(["package.json", "yarn.lock"])).toMatchObject({
      command: "yarn install --frozen-lockfile",
      packageManager: "yarn",
    });

    expect(
      inferInstallPlan(["package.json", "package-lock.json"]),
    ).toMatchObject({
      command: "npm ci",
      packageManager: "npm",
    });
  });

  it("allows package-only repos with a warning and rejects repos without package.json", () => {
    expect(inferInstallPlan(["package.json"])).toEqual({
      command: "npm install",
      packageManager: "npm",
      warnings: ["No lockfile found; npm install may be less deterministic."],
    });

    expect(() => inferInstallPlan(["README.md"])).toThrowError(
      "package.json is required for JavaScript/TypeScript project validation",
    );
  });
});
