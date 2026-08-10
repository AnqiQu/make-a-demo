/**
 * Marker prefix of an agent-liveness beat. The harness treats lines carrying
 * it as watchdog transport, never agent output: they must join the CPU
 * heartbeat in bootstrap-noise classification and evidence filtering.
 */
export const agentLivenessMarker = "[makeademo:agent-alive]";

/**
 * Minimum quiet time between beats. Well under the inactivity window so a
 * streaming-but-PTY-silent agent stays alive, and sparse enough that a
 * whole stage adds a few dozen lines of transport, not thousands.
 */
export const agentLivenessBeatIntervalMs = 25_000;

/**
 * Source of an OpenCode plugin (written to `<configDir>/plugin/`, which
 * OpenCode auto-loads) that turns model event-bus activity into throttled
 * `[makeademo:agent-alive]` beats on stderr. The PTY merges stderr into the
 * command's stream, so every beat feeds the no-output inactivity watchdog:
 * an agent that is thinking or streaming without touching the terminal
 * stops reading as silence, while a truly wedged OpenCode emits no events
 * and still dies at the deadline.
 *
 * The plugin must never influence the agent it reports on: it holds no
 * state beyond the throttle and swallows its own write failures.
 *
 * `beatIntervalMs` exists for tests that prove the throttle with a short
 * real interval; production callers use the default.
 */
export function createAgentLivenessPluginSource(
  options: { beatIntervalMs?: number } = {},
): string {
  const beatLine = `${agentLivenessMarker} model stream active\n`;
  return `const beatLine = ${JSON.stringify(beatLine)};
const beatIntervalMs = ${options.beatIntervalMs ?? agentLivenessBeatIntervalMs};

export const AgentLivenessPlugin = async () => {
  let lastBeatMs = 0;
  return {
    event: async () => {
      const nowMs = Date.now();
      if (nowMs - lastBeatMs < beatIntervalMs) {
        return;
      }
      lastBeatMs = nowMs;
      try {
        process.stderr.write(beatLine);
      } catch {
        // Liveness transport must never break the agent it reports on.
      }
    },
  };
};
`;
}
