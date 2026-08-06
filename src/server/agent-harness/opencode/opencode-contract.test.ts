import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// Opt-in contract test against the REAL OpenCode CLI: it spends model tokens
// and needs a configured OpenCode credential, so it only runs when the
// operator asks for it with MAKEADEMO_OPENCODE_CONTRACT=1. It pins the
// external behavior the harness runner is built on: the inline
// OPENCODE_CONFIG_CONTENT permission table stays binding under
// --dangerously-skip-permissions (the flag only suppresses interactive
// prompting), a denied write surfaces the rule-denial line the backend's
// denial matcher reads, `--format json` events carry a recoverable
// sessionID, and a >4KB prompt arrives intact through the file transport.
const contractEnabled = process.env.MAKEADEMO_OPENCODE_CONTRACT === "1";

describe.skipIf(!contractEnabled)("real OpenCode contract", () => {
  it("holds the permission table, reports denials, and keeps large prompts intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-opencode-contract-"));
    const repoDirectory = join(root, "repo");
    const configDirectory = join(root, "config");
    await execFileAsync("mkdir", ["-p", repoDirectory, configDirectory]);
    await writeFile(join(repoDirectory, "package.json"), '{"name":"probe"}\n');

    // Exact-string path rules are sensitive to OpenCode's project-root
    // discovery, which differs between a macOS tmpdir and the sandbox's
    // fixed /workspace layout (probed 2026-08-05 on OpenCode 1.17.19: a
    // bare "allowed.json" rule and a symlink-resolved absolute rule both
    // failed to match here while a globstar rule matched everywhere). The
    // production table's /workspace spellings are validated by real
    // pipeline runs; this test uses the environment-stable globstar
    // spelling so it probes the contract, not the host's root discovery.
    const config = {
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      instructions: [],
      permission: {
        "*": "deny",
        bash: "deny",
        doom_loop: "deny",
        edit: {
          "*": "deny",
          "**/allowed.json": "allow",
        },
        glob: "allow",
        grep: "allow",
        question: "deny",
        read: "allow",
        skill: "deny",
        task: "deny",
        webfetch: "deny",
        websearch: "deny",
      },
      plugin: [],
      share: "disabled",
    };

    // The nonce sits at the very end of a >4KB prompt: if any transport hop
    // truncated the prompt around MAX_CANON (4096 bytes), the nonce would be
    // the first casualty and the assertion below would fail.
    const nonce = "b7f2c9a1d4e8563f90ab12cd34ef5678";
    const padding = "Context line for transport sizing.\n".repeat(150);
    const prompt = [
      "You are probing a permission table. Follow these steps exactly.",
      padding,
      "Step 1: try to create a file named denied.txt containing DENIED_PROBE in the working directory.",
      `Step 2: when that write is refused by a permission rule, create a file named allowed.json in the working directory containing exactly {"nonce":"${nonce}"}.`,
      "Do nothing else, then stop.",
    ].join("\n");
    expect(prompt.length).toBeGreaterThan(4096);
    const promptPath = join(configDirectory, "prompt-contract.txt");
    await writeFile(promptPath, prompt);

    const model = `openai/${process.env.MAKEADEMO_OPENAI_MODEL?.trim() || "gpt-5.6-terra"}`;
    // stdin must be closed: under a piped stdin OpenCode waits for EOF
    // instead of exiting after the run completes.
    const command = [
      "opencode run",
      "--pure",
      "--dangerously-skip-permissions",
      "--format json",
      `--dir '${repoDirectory}'`,
      `--model '${model}'`,
      `"$(cat '${promptPath}')"`,
      "</dev/null",
    ].join(" ");
    const { stdout } = await execFileAsync("bash", ["-c", command], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_CONFIG_DIR: configDirectory,
        OPENCODE_ENABLE_EXA: "0",
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    });

    // The denied write must not land, and the denial must surface on an
    // event line naming the file — the shape the backend's denial matcher
    // (throwIfRequiredArtifactWriteWasDenied) reads.
    await expect(stat(join(repoDirectory, "denied.txt"))).rejects.toThrow();
    const denialLine = stdout
      .split("\n")
      .find(
        (line) =>
          line.includes("denied.txt") &&
          /specified a rule which prevents you from using this specific tool call/.test(
            line,
          ),
      );
    expect(denialLine).toBeDefined();

    // The allowed write proves the table is a table, not a blanket deny —
    // and the nonce proves the prompt tail survived the file transport.
    const allowed = await readFile(join(repoDirectory, "allowed.json"), "utf8");
    expect(JSON.parse(allowed)).toEqual({ nonce });

    // Session-id recovery: `--format json` event lines carry a top-level
    // sessionID the runner extracts to resume the session across stages.
    const sessionId = stdout
      .split("\n")
      .map((line) => {
        try {
          const value = JSON.parse(line.trim()) as { sessionID?: unknown };
          return typeof value.sessionID === "string" ? value.sessionID : "";
        } catch {
          return "";
        }
      })
      .find((value) => value.length > 0);
    expect(sessionId).toMatch(/^ses_/);
  }, 200_000);
});
