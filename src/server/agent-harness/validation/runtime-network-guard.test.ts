import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createRuntimeNetworkGuardSource,
  readRuntimeNetworkAttempts,
  runtimeNetworkMarker,
} from "./runtime-network-guard";

const execFileAsync = promisify(execFile);

describe("runtime network guard", () => {
  it("blocks and reports server-side fetch before the process reaches the network", async () => {
    const directory = await mkdtemp(join(tmpdir(), "makeademo-network-guard-"));
    const guardPath = join(directory, "guard.cjs");
    await writeFile(guardPath, createRuntimeNetworkGuardSource());

    let stderr = "";
    try {
      await execFileAsync(
        process.execPath,
        ["-e", 'fetch("https://api.example.com/data")'],
        {
          env: {
            ...process.env,
            NODE_OPTIONS: `--require=${guardPath}`,
          },
        },
      );
    } catch (error) {
      stderr = String(
        (error as { stderr?: string | Buffer }).stderr?.toString() ?? "",
      );
    }

    expect(stderr).toContain(runtimeNetworkMarker);
    expect(readRuntimeNetworkAttempts(stderr)).toEqual([
      {
        direction: "outbound",
        host: "api.example.com",
        phase: "runtime",
        url: "https://api.example.com/data",
      },
    ]);
  });
});
