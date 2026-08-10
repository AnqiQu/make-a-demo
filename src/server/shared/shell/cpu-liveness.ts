/**
 * Seconds between CPU samples. One line per minute keeps a 5-minute
 * no-output watchdog fed with five chances to observe progress while
 * adding negligible output to transcripts and evidence streams.
 */
const cpuSampleIntervalSeconds = 60;

/**
 * Sums utime+stime jiffies of every live process in the given process
 * group. Dead children are deliberately excluded (their jiffies vanish
 * from the sum, which itself registers as a change): counting the
 * reaper's cutime instead would count the sampler's own short-lived
 * awk/cat children and make a wedged tree look permanently alive.
 */
const readProcessGroupCpu = (processGroupVariable: string) =>
  `cat /proc/[0-9]*/stat 2>/dev/null | awk -v pg="$${processGroupVariable}" '{ s = $0; sub(/^[^)]*\\) /, "", s); if (split(s, f, " ") >= 13 && f[3] == pg) t += f[12] + f[13] } END { printf "%d", t }'`;

/**
 * Wraps a bash command so it emits a `[makeademo:alive] cpu <jiffies>`
 * line at most once per minute while the command's process group keeps
 * burning CPU, and stays silent once the tree goes idle.
 *
 * Purpose: no-output inactivity watchdogs read silence as death, but a
 * native compile or a buffering package manager can work silently for
 * longer than any reasonable window (ghost's `pnpm rebuild -r` was
 * killed mid-compile, 2026-08-09). The heartbeat feeds those watchdogs
 * through the output channel they already watch, so a silent working
 * command survives while a wedged one — silent AND idle — still dies at
 * the inactivity deadline.
 *
 * Contract for implementations and callers: the wrapped string must run
 * `command` in the current shell (its variable assignments stay visible
 * to any caller-appended trailer), must preserve the command's exit
 * status as its own, must never let the sampler outlive the command, and
 * must emit nothing when the command finishes inside the first sample
 * interval. The command runs with stdin sealed to /dev/null: wrapped
 * commands are sealed-runtime work that must never read the transport
 * (a stdin-draining child spinner stole the PTY exit sentinel and turned
 * a completed command into a false kill, ghostfolio 2026-08-09).
 * Heartbeat lines are transport, not evidence: consumers of
 * command output must filter `[makeademo:alive]` lines before excerpting
 * or interpreting it.
 *
 * The sampler scopes by process group read from /proc/self, which is only
 * correct when the wrapped string runs without job control (non-interactive
 * shells — the PTY transport's script execution qualifies): under an
 * interactive monitor-mode shell every pipeline gets its own process group
 * and the sampler would watch the idle shell's group instead of the
 * command's (the batch-wide silent heartbeat, 2026-08-09).
 */
export function withCpuLivenessHeartbeat(command: string): string {
  const sampler = [
    `makeademo_alive_pg=$(cat /proc/self/stat 2>/dev/null | awk '{ s = $0; sub(/^[^)]*\\) /, "", s); split(s, f, " "); print f[3] }')`,
    `{ makeademo_alive_last=""; while sleep ${cpuSampleIntervalSeconds}; do makeademo_alive_now=$(${readProcessGroupCpu("makeademo_alive_pg")}); if [ -n "$makeademo_alive_now" ] && [ "$makeademo_alive_now" != "$makeademo_alive_last" ]; then echo "[makeademo:alive] cpu $makeademo_alive_now"; fi; makeademo_alive_last="$makeademo_alive_now"; done; } & makeademo_alive_pid=$!`,
  ].join("; ");
  return `${sampler}; { ${command}; } </dev/null; makeademo_alive_status=$?; kill "$makeademo_alive_pid" 2>/dev/null; wait "$makeademo_alive_pid" 2>/dev/null; sh -c "exit $makeademo_alive_status"`;
}
