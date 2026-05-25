import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CLI smoke test can print help from the outside", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-cli-"));
  const result = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
  }>((resolve) => {
    const child = spawn("bun", ["run", "src/apps/cli/main.ts", "--help"], {
      cwd: process.cwd(),
      env: { ...process.env, SEED_CWD: cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });

  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(result.stdout).toContain("seed");
  expect(result.stdout).toContain("/model");
});
