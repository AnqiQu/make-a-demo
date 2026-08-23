import { createModelActivityObserver } from "./model-activity-observer";

// N170 (conduit, wave-18): a wall-killed repair attempt emitted PTY
// bootstrap plus fifteen CPU beats and zero OpenCode output ever — the CPU
// heartbeat alone fed the PTY watchdog for a quarter-hour. The observer
// separates harness transport from the model's own output so a launch that
// never speaks dies at the inactivity window instead of the wall.
describe("createModelActivityObserver", () => {
  it("does not count cpu liveness beats as activity before OpenCode speaks", () => {
    const observer = createModelActivityObserver();

    expect(observer.observe("[makeademo:alive] cpu 412\r\n")).toBe(false);
    expect(observer.observe("[makeademo:alive] cpu 498\r\n")).toBe(false);
    expect(observer.snapshot()).toMatchObject({
      cpuBeatCount: 2,
      modelOutputSeen: false,
    });
  });

  it("treats the prompt echo and heredoc continuation lines as transport", () => {
    const observer = createModelActivityObserver();

    expect(
      observer.observe(
        "root@sandbox:/workspace# bash <<'MAKEADEMO_RUN'\r\n> opencode run --print-logs\r\n> MAKEADEMO_RUN\r\n",
      ),
    ).toBe(false);
    expect(observer.snapshot().modelOutputSeen).toBe(false);
  });

  it("opens on the first model output line and counts every later chunk", () => {
    const observer = createModelActivityObserver();

    expect(observer.observe("[makeademo:alive] cpu 412\r\n")).toBe(false);
    expect(observer.observe('{"type":"session.created"}\r\n')).toBe(true);
    expect(observer.observe("[makeademo:alive] cpu 498\r\n")).toBe(true);
    expect(observer.snapshot().modelOutputSeen).toBe(true);
  });

  it("counts agent-liveness beats as model activity", () => {
    // Deliberate deviation from the launch-failure bootstrap pattern: the
    // plugin only beats when OpenCode's event bus delivers model events, so
    // a beat proves the agent is alive even before other stdout arrives.
    const observer = createModelActivityObserver();

    expect(observer.observe("[makeademo:agent-alive] step.updated\r\n")).toBe(
      true,
    );
  });

  it("classifies a cpu beat split across chunks as one transport line", () => {
    const observer = createModelActivityObserver();

    expect(observer.observe("[makeademo:al")).toBe(false);
    expect(observer.observe("ive] cpu 412\r\n")).toBe(false);
    expect(observer.snapshot()).toMatchObject({
      cpuBeatCount: 1,
      modelOutputSeen: false,
    });
  });

  it("holds an incomplete line until its newline proves what it is", () => {
    const observer = createModelActivityObserver();

    expect(observer.observe('{"type":"messa')).toBe(false);
    expect(observer.observe('ge.part.updated"}\r\n')).toBe(true);
  });

  it("ignores terminal escape sequences around transport lines", () => {
    const observer = createModelActivityObserver();

    expect(
      observer.observe("\u001b[2K\u001b[1G[makeademo:alive] cpu 412\r\n"),
    ).toBe(false);
  });

  it("records when the model last spoke and leaves beats out of it", () => {
    let nowMs = 1_000;
    const observer = createModelActivityObserver({ now: () => nowMs });

    observer.observe('{"type":"session.created"}\r\n');
    nowMs = 61_000;
    observer.observe("[makeademo:alive] cpu 498\r\n");

    expect(observer.snapshot()).toMatchObject({
      cpuBeatCount: 1,
      lastModelOutputAtMs: 1_000,
      modelOutputSeen: true,
    });
  });

  it("fails open when a single line outgrows the buffer without a newline", () => {
    const observer = createModelActivityObserver();

    expect(observer.observe(`{"delta":"${"x".repeat(70_000)}`)).toBe(true);
    expect(observer.snapshot().modelOutputSeen).toBe(true);
  });

  it("keeps an oversized prompt echo as transport through its whole line", () => {
    const observer = createModelActivityObserver();

    expect(
      observer.observe(`root@sandbox:/workspace# printf ${"x".repeat(70_000)}`),
    ).toBe(false);
    expect(observer.observe(`${"x".repeat(1_000)}\r\n`)).toBe(false);
    expect(observer.observe('{"type":"session.created"}\r\n')).toBe(true);
  });
});
