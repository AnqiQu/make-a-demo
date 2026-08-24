import { describe, expect, it } from "vitest";
import {
  commandsInvokePackageManager,
  readFloatingPackageManagerSelector,
} from "./package-manager-selector";

describe("readFloatingPackageManagerSelector", () => {
  it("reads a floating major-only selector", () => {
    // N175 (homer, wave-20): packageManager "pnpm@10" made corepack resolve
    // the tag against the registry at install time; five rounds went to a
    // one-line pin because the evidence said "network".
    expect(
      readFloatingPackageManagerSelector(
        JSON.stringify({ name: "homer", packageManager: "pnpm@10" }),
      ),
    ).toEqual({ manager: "pnpm", selector: "pnpm@10" });
  });

  it("treats range, tag, and versionless selectors as floating", () => {
    for (const selector of [
      "pnpm@^10.2.0",
      "yarn@stable",
      "npm@latest",
      "pnpm@10.2",
      "pnpm",
    ]) {
      expect(
        readFloatingPackageManagerSelector(
          JSON.stringify({ packageManager: selector }),
        ),
      ).toEqual({
        manager: selector.split("@")[0],
        selector,
      });
    }
  });

  it("accepts exact pins, with prerelease and integrity suffixes", () => {
    for (const selector of [
      "pnpm@10.12.1",
      "yarn@4.5.0",
      "npm@10.9.2",
      "pnpm@9.0.0-rc.2",
      "yarn@4.5.0+sha224.c2c2d2a4e9d8ec7c9a3f1b8f2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f",
    ]) {
      expect(
        readFloatingPackageManagerSelector(
          JSON.stringify({ packageManager: selector }),
        ),
      ).toBeUndefined();
    }
  });

  it("ignores managers corepack does not materialize", () => {
    expect(
      readFloatingPackageManagerSelector(
        JSON.stringify({ packageManager: "bun@1.2" }),
      ),
    ).toBeUndefined();
    expect(
      readFloatingPackageManagerSelector(
        JSON.stringify({ packageManager: "deno@2" }),
      ),
    ).toBeUndefined();
  });

  it("ignores absent, non-string, and malformed declarations", () => {
    expect(
      readFloatingPackageManagerSelector(JSON.stringify({ name: "app" })),
    ).toBeUndefined();
    expect(
      readFloatingPackageManagerSelector(
        JSON.stringify({ packageManager: 10 }),
      ),
    ).toBeUndefined();
    expect(
      readFloatingPackageManagerSelector("not json at all"),
    ).toBeUndefined();
    expect(readFloatingPackageManagerSelector("")).toBeUndefined();
  });
});

describe("commandsInvokePackageManager", () => {
  it("matches the manager as a command token across compound commands", () => {
    expect(
      commandsInvokePackageManager(
        ["corepack enable && pnpm install --frozen-lockfile"],
        "pnpm",
      ),
    ).toBe(true);
    expect(commandsInvokePackageManager(["FOO=1 pnpm run build"], "pnpm")).toBe(
      true,
    );
  });

  it("does not match the manager name embedded in scopes or flags", () => {
    expect(
      commandsInvokePackageManager(
        ["bun install --filter=@pnpm/config", "bun run start"],
        "pnpm",
      ),
    ).toBe(false);
  });

  it("skips null and undefined lifecycle commands", () => {
    expect(
      commandsInvokePackageManager([undefined, null, "yarn start"], "yarn"),
    ).toBe(true);
    expect(commandsInvokePackageManager([undefined, null], "yarn")).toBe(false);
  });
});
