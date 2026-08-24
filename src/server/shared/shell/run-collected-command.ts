import { spawn } from "node:child_process";

/**
 * Spawns a local command with piped stdout/stderr and resolves once it
 * closes, with the full collected output. `exitCode` is null when the
 * process was terminated by a signal; the promise rejects only when the
 * process cannot be spawned at all. Stdin is ignored, so implementations
 * must never run commands that expect interactive input.
 */
export async function runCollectedCommand(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}
