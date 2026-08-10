import { describe, expect, it } from "vitest";
import { createPtyCommandPayload } from "./pty-command-payload";

describe("createPtyCommandPayload", () => {
  const exitSentinel = "__MAKEADEMO_EXIT_deadbeefdeadbeef__";

  it("hands the interactive shell the whole script upfront with nothing left behind", () => {
    const payload = createPtyCommandPayload({
      command: "npm run build",
      exitSentinel,
    });

    const lines = payload.split("\n");
    // Everything after the exec line is heredoc body the interactive shell
    // consumes before the command starts, so no unconsumed input sits in
    // the tty buffer across a multi-minute command (a pre-queued sentinel
    // line was stolen by a stdin-draining child, ghostfolio 2026-08-09).
    expect(lines[1]).toMatch(
      /^exec bash -s <<'__MAKEADEMO_SCRIPT_[A-Za-z0-9]+__' \|\| exit$/,
    );
    const scriptTag = /__MAKEADEMO_SCRIPT_[A-Za-z0-9]+__/.exec(payload)?.[0];
    expect(scriptTag).toBeDefined();
    // The terminator is the final line: the payload carries no trailing
    // input for anything to steal, and ends with the newline the tty's
    // line discipline needs to deliver it.
    expect(payload.endsWith(`\n${scriptTag}\n`)).toBe(true);
  });

  it("seals the command's stdin while preserving the command verbatim", () => {
    const payload = createPtyCommandPayload({
      command: "line one\nline two",
      exitSentinel,
    });

    // Children inheriting stdin (ora/inquirer spinners) must read
    // /dev/null, never the script stream that carries the exit trailer.
    expect(payload).toContain("{\nline one\nline two\n} </dev/null\n");
  });

  it("carries the exit trailer inside the script so the command's own shell reports it", () => {
    const payload = createPtyCommandPayload({
      command: "exit 7",
      exitSentinel,
    });

    expect(payload).toContain(`printf '\\n${exitSentinel}:%s\\n' $?`);
    // The quoted heredoc tag keeps $? literal until the inner shell runs
    // it after the command — an unquoted tag would expand it at send time
    // and always report the pre-command status.
    const execLine = payload.split("\n")[1] ?? "";
    expect(execLine).toContain("<<'__MAKEADEMO_SCRIPT_");
  });

  it("suppresses input echo before anything else", () => {
    const payload = createPtyCommandPayload({
      command: "npm run build",
      exitSentinel,
    });

    expect(payload.split("\n")[0]).toBe("stty -echo");
  });

  it("gives each payload its own script tag", () => {
    const readTag = (payload: string) =>
      /__MAKEADEMO_SCRIPT_[A-Za-z0-9]+__/.exec(payload)?.[0];
    const first = readTag(
      createPtyCommandPayload({ command: "true", exitSentinel }),
    );
    const second = readTag(
      createPtyCommandPayload({ command: "true", exitSentinel }),
    );

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });
});
