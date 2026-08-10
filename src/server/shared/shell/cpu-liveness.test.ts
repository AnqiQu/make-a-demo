import { describe, expect, it } from "vitest";
import { withCpuLivenessHeartbeat } from "./cpu-liveness";

describe("withCpuLivenessHeartbeat", () => {
  it("runs the original command with a background sampler that emits alive markers", () => {
    const wrapped = withCpuLivenessHeartbeat("npm run build");

    expect(wrapped).toContain("npm run build");
    expect(wrapped).toContain("[makeademo:alive] cpu");
    // The sampler must run alongside the command, not before or after it,
    // and must not outlive it.
    expect(wrapped).toMatch(/&\s+makeademo_alive_pid=\$!/);
    expect(wrapped).toContain("kill");
  });

  it("preserves the wrapped command's exit status past the sampler teardown", () => {
    const wrapped = withCpuLivenessHeartbeat("exit 7");

    // The status is captured immediately after the command; the kill/wait
    // teardown must not clobber it, and the trailing exit re-raises it
    // without a top-level `exit` (which would drop a PTY sentinel).
    expect(wrapped).toMatch(
      /\{ exit 7; \} <\/dev\/null; makeademo_alive_status=\$\?; kill .*sh -c "exit \$makeademo_alive_status"$/,
    );
  });

  it("seals the wrapped command's stdin so its children cannot drain the transport", () => {
    const wrapped = withCpuLivenessHeartbeat("npx prisma generate");

    // A child that reads inherited stdin (ora/inquirer spinners) must get
    // /dev/null, never the PTY buffer or script stream that carries the
    // harness's own trailer lines (ghostfolio's stolen exit sentinel,
    // 2026-08-09).
    expect(wrapped).toContain("{ npx prisma generate; } </dev/null;");
  });

  it("samples only the command's own process group and speaks only on change", () => {
    const wrapped = withCpuLivenessHeartbeat("sleep 1");

    // Sandbox daemons outside the command's tree must not keep a wedged
    // command alive: the sampler scopes to its own process group read
    // from /proc/self/stat.
    expect(wrapped).toContain("/proc/self/stat");
    expect(wrapped).toContain("/proc/[0-9]*/stat");
    expect(wrapped).toContain("f[3] == pg");
    // A constant CPU total is silence — the heartbeat fires only when the
    // sampled total differs from the previous sample.
    expect(wrapped).toContain(
      '[ "$makeademo_alive_now" != "$makeademo_alive_last" ]',
    );
  });
});
