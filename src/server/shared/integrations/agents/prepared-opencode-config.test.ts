import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPreparedOpenCodeFiles,
  writePreparedOpenCodeFiles,
} from "./prepared-opencode-config";

describe("createPreparedOpenCodeFiles", () => {
  it("defines the four security reviewer subagents with structured accept/reject contracts", () => {
    const files = createPreparedOpenCodeFiles();
    const agents = Object.fromEntries(
      files
        .filter((file) => file.path.startsWith(".config/opencode/agents/"))
        .map((file) => [file.path, file.content]),
    );

    expect(Object.keys(agents).sort()).toEqual([
      ".config/opencode/agents/dependency-reviewer.md",
      ".config/opencode/agents/obfuscation-deception-auditor.md",
      ".config/opencode/agents/prompt-injection-reviewer.md",
      ".config/opencode/agents/runtime-security-reviewer.md",
    ]);
    expect(agents[".config/opencode/agents/dependency-reviewer.md"]).toContain(
      "mode: subagent",
    );
    expect(agents[".config/opencode/agents/dependency-reviewer.md"]).toContain(
      "permission: allow",
    );
    expect(agents[".config/opencode/agents/dependency-reviewer.md"]).toContain(
      "dependency manifests and install lifecycle hooks",
    );

    for (const content of Object.values(agents)) {
      expect(content).toContain('"status":"accepted"');
      expect(content).toContain('"status":"rejected"');
      expect(content).toContain("Return only JSON");
    }
  });

  it("writes prepared OpenCode files relative to an OpenCode home directory", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "makeademo-test-home-"));

    try {
      await writePreparedOpenCodeFiles(homeDirectory);

      await expect(
        readFile(
          join(homeDirectory, ".config/opencode/agents/dependency-reviewer.md"),
          "utf8",
        ),
      ).resolves.toContain("dependency manifests and install lifecycle hooks");
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
