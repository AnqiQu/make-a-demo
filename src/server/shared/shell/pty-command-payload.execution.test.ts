import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { withCpuLivenessHeartbeat } from "./cpu-liveness";
import { createPtyCommandPayload } from "./pty-command-payload";

/**
 * Real-PTY execution proof for the sealed transport, Linux-only: it needs
 * /proc for the heartbeat's process-group capture and util-linux `script`
 * for a genuine interactive (job-control) bash on a pty — the exact shape
 * the Daytona provider talks to. These are the behaviors no string
 * assertion can prove: sentinel delivery past stdin/tty-draining children,
 * and the heartbeat actually observing the command's own CPU.
 */
const canRunLinuxPty = process.platform === "linux";

const exitSentinel = "__MAKEADEMO_EXIT_executiontest00__";

function runThroughInteractivePty(
  payload: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "script",
      ["-qec", "bash --noprofile --norc -i", "/dev/null"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const output: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `pty run did not finish within ${timeoutMs}ms; output so far:\n${Buffer.concat(output).toString()}`,
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(output).toString());
    });
    // Written once, upfront — exactly how the provider sends it. stdin
    // stays open: an EOF-closed pty master would HUP the shell mid-run.
    child.stdin.write(payload);
  });
}

describe.skipIf(!canRunLinuxPty)(
  "sealed pty transport on a real interactive pty",
  () => {
    it("delivers the exit sentinel although children drain stdin and /dev/tty", async () => {
      // The two theft modes of the 2026-08-09 false-kill class: a child
      // reading inherited stdin (ora/inquirer spinners) and a child
      // opening /dev/tty directly. Each blocks briefly against an empty,
      // sealed transport instead of eating the exit trailer.
      const payload = createPtyCommandPayload({
        command: [
          "timeout 1 cat >/dev/null",
          "timeout 1 head -c 4096 /dev/tty >/dev/null 2>/dev/null",
          // Output text is computed so it can never be satisfied by the
          // pty echoing the input script back.
          'echo "drains-$((1+1))-survived"',
          "false",
        ].join("\n"),
        exitSentinel,
      });

      const output = await runThroughInteractivePty(payload, 15_000);

      expect(output).toContain("drains-2-survived");
      expect(output).toMatch(
        new RegExp(`${exitSentinel}:1`.replaceAll("$", "\\$")),
      );
    }, 20_000);

    it("emits a heartbeat for the command's own silent CPU burn", async () => {
      // The sampler scopes to the process group it reads from /proc/self.
      // Under the sealed transport the script runs without job control,
      // so that group is the command's own tree — this is the execution
      // proof that the heartbeat observes real work (it was silent
      // batch-wide under the interactive transport, 2026-08-09).
      const payload = createPtyCommandPayload({
        command: withCpuLivenessHeartbeat(
          'while (( SECONDS < 3 )); do :; done; echo "burn-$((1+1))-done"',
          { sampleIntervalSeconds: 1 },
        ),
        exitSentinel,
      });

      const output = await runThroughInteractivePty(payload, 15_000);

      expect(output).toContain("burn-2-done");
      // Digits required: the echoed sampler source carries the literal
      // "$makeademo_alive_now", never a sampled number.
      expect(output).toMatch(/\[makeademo:alive\] cpu \d+/);
      expect(output).toContain(`${exitSentinel}:0`);
    }, 20_000);
  },
);
