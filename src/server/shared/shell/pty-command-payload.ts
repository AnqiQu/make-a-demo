import { randomUUID } from "node:crypto";

/**
 * Builds the complete input payload for running one command through an
 * interactive PTY shell such that, while the command runs, no unconsumed
 * input remains anywhere a child process could steal it.
 *
 * Transport truth, in three guarantees (each closes a hole the others
 * cannot — a completed prisma generate was killed as a false exit-124
 * after its spinner drained the pre-queued sentinel line, 2026-08-09):
 *
 * 1. The whole script travels as a quoted heredoc that the interactive
 *    shell consumes upfront, so the tty buffer is empty for the command's
 *    entire lifetime — a child that opens /dev/tty directly finds nothing.
 * 2. The command runs with stdin sealed to /dev/null, so a child that
 *    reads inherited stdin drains neither the tty nor the heredoc script
 *    stream that carries the exit trailer.
 * 3. The exit trailer (`printf '<sentinel>:<status>'`) lives inside the
 *    script itself, after the command — never as separately queued input.
 *
 * The `exec` replaces the interactive shell with a non-interactive
 * `bash -s`: the session still ends when the script does (the caller's
 * `pty.wait()` contract), and job control is off, which is what makes
 * `withCpuLivenessHeartbeat`'s /proc/self process-group capture see the
 * command's own tree instead of an idle interactive shell's.
 *
 * Callers must keep each command line under the tty's canonical-mode line
 * limit (~4KB); the heredoc preserves the command's own line structure,
 * so this builder never lengthens the longest line.
 */
export function createPtyCommandPayload(input: {
  command: string;
  exitSentinel: string;
}): string {
  // Nonce'd so submitted code cannot craft a terminator collision; quoted
  // at the redirection so `$?` in the trailer resolves when the command
  // finishes, not when the payload is built.
  const scriptTag = `__MAKEADEMO_SCRIPT_${randomUUID().replaceAll("-", "")}__`;
  return [
    "stty -echo",
    // `|| exit` only runs if exec itself fails (interactive shells survive
    // a failed exec): the session still ends instead of idling at a prompt
    // until the inactivity watchdog kills it as a false hang.
    `exec bash -s <<'${scriptTag}' || exit`,
    "{",
    input.command,
    "} </dev/null",
    `printf '\\n${input.exitSentinel}:%s\\n' $?`,
    scriptTag,
    "",
  ].join("\n");
}
