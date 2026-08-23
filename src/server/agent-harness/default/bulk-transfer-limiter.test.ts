import { describe, expect, it } from "vitest";
import { createBulkTransferLimiter } from "./bulk-transfer-limiter";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("BulkTransferLimiter", () => {
  it("runs transfers one at a time in submission order", async () => {
    const limiter = createBulkTransferLimiter();
    const events: string[] = [];
    const firstGate = deferred();

    const first = limiter.run(async () => {
      events.push("first started");
      await firstGate.promise;
      events.push("first finished");
      return "first";
    });
    const second = limiter.run(async () => {
      events.push("second started");
      return "second";
    });

    // The second transfer must not start while the first holds the lock.
    await Promise.resolve();
    expect(events).toEqual(["first started"]);

    firstGate.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual([
      "first started",
      "first finished",
      "second started",
    ]);
  });

  it("releases the lock when a transfer fails", async () => {
    const limiter = createBulkTransferLimiter();

    await expect(
      limiter.run(async () => {
        throw new Error("clone died mid-transfer");
      }),
    ).rejects.toThrow("clone died mid-transfer");
    await expect(limiter.run(async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });
});
