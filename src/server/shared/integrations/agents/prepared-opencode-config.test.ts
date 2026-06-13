import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createMakeADemoOpenCodeConfigFiles,
  createPreparedOpenCodeFiles,
  writePreparedOpenCodeFiles,
} from "./prepared-opencode-config";

describe("createMakeADemoOpenCodeConfigFiles", () => {
  it("exposes only the backend-controlled dependency install tool", () => {
    const files = createMakeADemoOpenCodeConfigFiles();
    const byPath = Object.fromEntries(
      files.map((file) => [file.path, file.content]),
    );

    expect(byPath["opencode.json"]).toContain(
      '"makeademo_dependency_request_install": true',
    );
    expect(byPath["opencode.json"]).not.toContain("makeademo_review_conclude");
    expect(files.some((file) => file.path.startsWith("agents/"))).toBe(false);

    const plugin = byPath["plugins/makeademo-tools.ts"];
    expect(plugin).toContain("makeademo_dependency_request_install");
    expect(plugin).toContain("dependency-install-request.json");
    expect(plugin).not.toContain("makeademo_review_conclude");
    expect(plugin).not.toContain("review-outcomes.jsonl");
  });
});

describe("createPreparedOpenCodeFiles", () => {
  it("writes prepared OpenCode files relative to an OpenCode home directory", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "makeademo-test-home-"));

    try {
      await writePreparedOpenCodeFiles(homeDirectory);

      await expect(
        readFile(
          join(homeDirectory, ".config/opencode/skills/find-docs/SKILL.md"),
          "utf8",
        ),
      ).resolves.toContain("Context7");
    } finally {
      await rm(homeDirectory, { force: true, recursive: true });
    }
  });

  it("includes a Context7 skill that instructs the agent to use the ctx7 CLI", () => {
    const files = createPreparedOpenCodeFiles();
    const skill = files.find(
      (file) => file.path === ".config/opencode/skills/find-docs/SKILL.md",
    );

    expect(skill?.content).toContain("ctx7 library");
    expect(skill?.content).toContain("ctx7 docs");
    expect(skill?.content).toContain("Context7");
  });
});
