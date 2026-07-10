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
  it("creates OpenCode config files with MakeADemo tools enabled and outer shell execution denied", () => {
    const files = createMakeADemoOpenCodeConfigFiles();
    const configFile = files.find((file) => file.path === "opencode.json");
    const config = JSON.parse(configFile?.content ?? "{}");

    expect(config.model).toBe("openai/gpt-5.6-luna");
    expect(config.provider.openai.models["gpt-5.6-luna"].options).toEqual({
      reasoningEffort: "max",
    });
    expect(config.agent).toBeUndefined();
    expect(config.permission).toEqual({
      "*": "allow",
      bash: "deny",
      makeademo_dependency_request_install: "allow",
      makeademo_submit_preparation_result: "allow",
      makeademo_validate_preparation: "allow",
    });
    expect(config.tools).toBeUndefined();
    expect(files.some((file) => file.path.startsWith("agents/"))).toBe(false);
    expect(files.map((file) => file.path).sort()).toEqual([
      "opencode.json",
      "plugins/makeademo-tools.ts",
      "skills/find-docs/SKILL.md",
    ]);
    const plugin = files.find(
      (file) => file.path === "plugins/makeademo-tools.ts",
    )?.content;
    expect(plugin).toContain("preparationManifestPath");
    expect(plugin).toContain("manifestPath: tool.schema.string()");
    expect(plugin).toContain("preparation preflight");
    expect(plugin).toContain("manifest = await assertValidationPassed()");
    expect(plugin).not.toContain("assertValidationPassed(args.manifest)");
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
