/**
 * What one attempt's PTY stream proved about the agent behind it (N170).
 * `modelOutputSeen` is the wedge discriminator: an attempt that dies with
 * it false never launched a speaking agent — every byte was shell echo or
 * harness heartbeat. `cpuBeatCount` sizes how long the heartbeat alone
 * carried the stream; `lastModelOutputAtMs` dates the model's final word.
 */
type ModelActivitySnapshot = {
  cpuBeatCount: number;
  lastModelOutputAtMs: number | undefined;
  modelOutputSeen: boolean;
};

/**
 * Classifies an OpenCode attempt's PTY stream into harness transport
 * versus the model's own output, so the command inactivity watchdog only
 * counts output that proves an agent is actually speaking (N170, conduit
 * wave-18: fifteen CPU beats fed the watchdog for a quarter-hour while
 * OpenCode never emitted a byte).
 *
 * `observe` is shaped for the workspace `activityFilter` seam: it consumes
 * one streamed chunk and returns whether the watchdog should count it as
 * activity. Implementations must never count CPU liveness beats or PTY
 * bootstrap echo before the first model output, must count everything once
 * the model has spoken (exactly the pre-N170 semantics), and must fail
 * open — an ambiguous chunk may earn an extra touch, never a starved one.
 * Agent-liveness beats count as model output by design: the plugin only
 * beats when OpenCode's event bus delivers model events.
 */
export type ModelActivityObserver = {
  observe: (chunk: string) => boolean;
  snapshot: () => ModelActivitySnapshot;
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal ANSI escapes requires matching the ESC byte
const ansiEscapePattern = /\u001b\[[0-9;?]*[A-Za-z]/g;
const cpuBeatLinePattern = /^\[makeademo:alive\] cpu \d+$/;
// The launch-failure bootstrap pattern minus the agent-alive beat: prompt
// echo (carrying the launched command), heredoc continuation echo, the exit
// trailer, the shell's own exec diagnostic, and session teardown. Only the
// prompt and continuation alternatives can grow without bound, and both
// classify correctly from a truncated prefix because they accept any tail.
const shellEchoLinePattern =
  /^(?:[^@\s]+@[^\n#]*#.*|>.*|__MAKEADEMO_EXIT(?:_[A-Za-z0-9]+)?__:\d+|bash: [^:\n]+: .+|logout)$/;
// A single buffered line larger than any real transport line except the
// echoed launch command, which the prompt/continuation prefixes classify.
const maxBufferedLineLength = 64 * 1024;

export function createModelActivityObserver(options?: {
  now?: () => number;
}): ModelActivityObserver {
  const now = options?.now ?? Date.now;
  let buffered = "";
  let discardingOversizedTransportLine = false;
  let cpuBeatCount = 0;
  let lastModelOutputAtMs: number | undefined;
  let modelOutputSeen = false;

  const classifyLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (cpuBeatLinePattern.test(trimmed)) {
      cpuBeatCount += 1;
      return;
    }
    if (shellEchoLinePattern.test(trimmed)) {
      return;
    }
    modelOutputSeen = true;
    lastModelOutputAtMs = now();
  };

  return {
    observe(chunk: string): boolean {
      const text = chunk.replaceAll(ansiEscapePattern, "");
      const segments = (buffered + text).split(/\r\n|\n|\r/);
      buffered = segments.pop() ?? "";
      for (const line of segments) {
        if (discardingOversizedTransportLine) {
          discardingOversizedTransportLine = false;
          continue;
        }
        classifyLine(line);
      }
      if (discardingOversizedTransportLine) {
        buffered = "";
      } else if (buffered.length > maxBufferedLineLength) {
        // Classify the oversized line from its prefix now: the unbounded
        // transport shapes tolerate truncation, and anything else fails
        // open as model output rather than starving a working agent.
        if (shellEchoLinePattern.test(buffered.trim())) {
          discardingOversizedTransportLine = true;
        } else {
          classifyLine(buffered);
        }
        buffered = "";
      }
      return modelOutputSeen;
    },
    snapshot(): ModelActivitySnapshot {
      return { cpuBeatCount, lastModelOutputAtMs, modelOutputSeen };
    },
  };
}
