export type SandboxCapacityEvidence = {
  cpuCount?: number;
  memoryMaxBytes?: number;
  oomKills?: number;
  totalMemoryMiB?: number;
};

/**
 * Probes the cgroup OOM-kill counter and the sandbox's memory/cpu allocation.
 * The ambiguous bare-number outputs (`memory.max`, `nproc`) are labeled inline
 * so `readSandboxCapacityEvidence` can parse them unambiguously.
 */
export const sandboxCapacityProbeCommand =
  "printf 'memory.max: '; cat /sys/fs/cgroup/memory.max 2>/dev/null || echo unavailable; cat /sys/fs/cgroup/memory.events 2>/dev/null; free -m 2>/dev/null; printf 'nproc: '; nproc 2>/dev/null || echo unavailable";

/**
 * Parses `sandboxCapacityProbeCommand` output. Fields missing from the output
 * (cgroup v2 accounting unavailable, `memory.max` set to `max`) stay undefined
 * so callers can distinguish "no OOM kills" from "no OOM accounting".
 */
export function readSandboxCapacityEvidence(
  output: string,
): SandboxCapacityEvidence {
  const evidence: SandboxCapacityEvidence = {};
  const memoryMax = /^memory\.max: (\d+)$/m.exec(output);
  if (memoryMax?.[1] !== undefined) {
    evidence.memoryMaxBytes = Number(memoryMax[1]);
  }
  const oomKills = /^oom_kill (\d+)$/m.exec(output);
  if (oomKills?.[1] !== undefined) {
    evidence.oomKills = Number(oomKills[1]);
  }
  const totalMemory = /^Mem:\s+(\d+)/m.exec(output);
  if (totalMemory?.[1] !== undefined) {
    evidence.totalMemoryMiB = Number(totalMemory[1]);
  }
  const cpuCount = /^nproc: (\d+)$/m.exec(output);
  if (cpuCount?.[1] !== undefined) {
    evidence.cpuCount = Number(cpuCount[1]);
  }
  return evidence;
}

/**
 * Minimum submitted-code sandbox allocation for exploring framework dev
 * servers (Next/Turbopack-class apps). Memory is compared against `free -m`
 * totals, which report slightly under the nominal 4 GiB after kernel reserves.
 */
const submittedCodeSandboxCapacityFloor = {
  cpuCount: 2,
  memoryMiB: 3900,
};

/**
 * Throws when the probed sandbox cannot host a framework dev server, naming
 * the snapshot environment variable to rebuild. Unknown capacity is treated
 * as failure: a probe that reports nothing proves nothing.
 */
export function assertSandboxMeetsCapacityFloor(
  evidence: SandboxCapacityEvidence,
): void {
  const floor = submittedCodeSandboxCapacityFloor;
  if (
    evidence.totalMemoryMiB !== undefined &&
    evidence.totalMemoryMiB >= floor.memoryMiB &&
    evidence.cpuCount !== undefined &&
    evidence.cpuCount >= floor.cpuCount
  ) {
    return;
  }
  throw new Error(
    `Submitted-code sandbox capacity is below the dev-server floor (memory ${evidence.totalMemoryMiB ?? "unknown"} MiB < ${floor.memoryMiB} MiB or cpu ${evidence.cpuCount ?? "unknown"} < ${floor.cpuCount}). Rebuild the MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT snapshot with a larger sandbox class.`,
  );
}
