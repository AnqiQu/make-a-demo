import { describe, expect, it } from "vitest";

import {
  assertSandboxMeetsCapacityFloor,
  readSandboxCapacityEvidence,
  sandboxCapacityProbeCommand,
} from "./sandbox-capacity";

const probeOutput = [
  "memory.max: 2147483648",
  "low 0",
  "high 0",
  "max 44",
  "oom 3",
  "oom_kill 2",
  "oom_group_kill 0",
  "               total        used        free      shared  buff/cache   available",
  "Mem:            2048        1900          48           0         100          60",
  "Swap:              0           0           0",
  "nproc: 1",
].join("\n");

describe("readSandboxCapacityEvidence", () => {
  it("reads oom kills, memory ceiling, total memory, and cpu count from probe output", () => {
    expect(readSandboxCapacityEvidence(probeOutput)).toEqual({
      cpuCount: 1,
      memoryMaxBytes: 2_147_483_648,
      oomKills: 2,
      totalMemoryMiB: 2048,
    });
  });

  it("returns no oom evidence when cgroup accounting is unavailable", () => {
    const output = [
      "memory.max: max",
      "               total        used        free",
      "Mem:            7942        1200        6000",
      "nproc: 4",
    ].join("\n");

    expect(readSandboxCapacityEvidence(output)).toEqual({
      cpuCount: 4,
      totalMemoryMiB: 7942,
    });
  });
});

describe("assertSandboxMeetsCapacityFloor", () => {
  it("rejects a sandbox below the dev-server floor and names the snapshot to rebuild", () => {
    expect(() =>
      assertSandboxMeetsCapacityFloor(readSandboxCapacityEvidence(probeOutput)),
    ).toThrow(/MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT/);
  });

  it("accepts a sandbox at or above the dev-server floor", () => {
    expect(() =>
      assertSandboxMeetsCapacityFloor({ cpuCount: 2, totalMemoryMiB: 3900 }),
    ).not.toThrow();
  });

  it("rejects a probe that reports no capacity numbers at all", () => {
    expect(() => assertSandboxMeetsCapacityFloor({})).toThrow(/capacity/i);
  });
});

describe("sandboxCapacityProbeCommand", () => {
  it("labels the ambiguous numeric outputs so evidence parsing cannot misread them", () => {
    expect(sandboxCapacityProbeCommand).toContain("memory.max: ");
    expect(sandboxCapacityProbeCommand).toContain("nproc: ");
  });
});
