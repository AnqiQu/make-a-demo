import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createMakeADemoOpenCodeConfigFiles,
  createPreparedOpenCodeFiles,
  writePreparedOpenCodeFiles,
} from "./prepared-opencode-config";

describe("createMakeADemoOpenCodeConfigFiles", () => {
  it("creates OpenCode config files with MakeADemo tools enabled", () => {
    const files = createMakeADemoOpenCodeConfigFiles();
    const configFile = files.find((file) => file.path === "opencode.json");
    const config = JSON.parse(configFile?.content ?? "{}");

    expect(config.tools).toEqual({
      makeademo_dependency_request_install: true,
      makeademo_submit_preparation_result: true,
    });
    expect(files.some((file) => file.path.startsWith("agents/"))).toBe(false);
    expect(files.map((file) => file.path).sort()).toEqual([
      "opencode.json",
      "plugins/makeademo-tools.ts",
      "skills/find-docs/SKILL.md",
    ]);
  });
});

describe("createPreparedOpenCodeFiles", () => {
  it("writes prepared OpenCode files relative to an OpenCode home directory", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "makeademo-test-home-"));

    try {
      await writePreparedOpenCodeFiles(homeDirectory);

      await access(
        join(homeDirectory, ".config/opencode/skills/find-docs/SKILL.md"),
      );
    } finally {
      await rm(homeDirectory, { force: true, recursive: true });
    }
  });

  it("includes the expected prepared file paths", () => {
    const files = createPreparedOpenCodeFiles();

    expect(files.map((file) => file.path)).toEqual([
      ".config/opencode/skills/find-docs/SKILL.md",
    ]);
  });
});
