import { describe, expect, it } from "vitest";
import {
  createBulkTransferLimiter,
  createTransferSlotAcquirer,
} from "./bulk-transfer-limiter";

async function settleMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve();
  }
}

describe("BulkTransferLimiter", () => {
  it("hands the slot to one acquirer at a time in acquisition order, reporting queue depth", async () => {
    const limiter = createBulkTransferLimiter();
    const events: string[] = [];

    const first = limiter.acquire();
    expect(first.queuedBehind).toBe(0);
    const releaseFirst = await first.lease;

    const second = limiter.acquire();
    const third = limiter.acquire();
    expect(second.queuedBehind).toBe(1);
    expect(third.queuedBehind).toBe(2);
    void second.lease.then(() => events.push("second granted"));
    void third.lease.then(() => events.push("third granted"));

    await settleMicrotasks();
    expect(events).toEqual([]);

    releaseFirst();
    await settleMicrotasks();
    expect(events).toEqual(["second granted"]);

    (await second.lease)();
    await settleMicrotasks();
    expect(events).toEqual(["second granted", "third granted"]);
  });

  it("ignores a duplicate release instead of freeing the slot twice", async () => {
    const limiter = createBulkTransferLimiter();
    const releaseFirst = await limiter.acquire().lease;
    releaseFirst();
    releaseFirst();

    const second = limiter.acquire();
    expect(second.queuedBehind).toBe(0);
    const releaseSecond = await second.lease;
    const third = limiter.acquire();
    expect(third.queuedBehind).toBe(1);
    let thirdGranted = false;
    void third.lease.then(() => {
      thirdGranted = true;
    });
    await settleMicrotasks();
    expect(thirdGranted).toBe(false);

    releaseSecond();
    await third.lease;
  });
});

describe("createTransferSlotAcquirer", () => {
  it("reports a queued wait in the run's own log with the waited duration", async () => {
    // N177 (wave-21): four runs waited 45+ minutes behind one wedged upload
    // and their logs read as silence — no event marked them as queued.
    const limiter = createBulkTransferLimiter();
    const entries: Record<string, unknown>[] = [];
    let nowMs = 1_000;
    const releaseHolder = await limiter.acquire().lease;
    const acquireSlot = createTransferSlotAcquirer({
      limiter,
      logger: {
        info: async (entry) => {
          entries.push(entry);
        },
      },
      now: () => nowMs,
      transfer: "screened-archive-upload",
    });

    const pendingAcquire = acquireSlot();
    await settleMicrotasks();
    expect(entries).toEqual([
      expect.objectContaining({
        event: "transfer.queue.waiting",
        queuedBehind: 1,
        transfer: "screened-archive-upload",
      }),
    ]);
    expect(entries[0]?.message).toContain("queued behind 1 transfer");

    nowMs = 47_000;
    releaseHolder();
    const release = await pendingAcquire;
    expect(entries[1]).toEqual(
      expect.objectContaining({
        event: "transfer.queue.acquired",
        queuedBehind: 1,
        transfer: "screened-archive-upload",
        waitedMs: 46_000,
      }),
    );
    release();
  });

  it("acquires silently when the slot is immediately free", async () => {
    const limiter = createBulkTransferLimiter();
    const entries: Record<string, unknown>[] = [];
    const acquireSlot = createTransferSlotAcquirer({
      limiter,
      logger: {
        info: async (entry) => {
          entries.push(entry);
        },
      },
      transfer: "repo-snapshot",
    });

    const release = await acquireSlot();
    expect(entries).toEqual([]);

    // The lease is real: a competing acquisition queues behind it.
    expect(limiter.acquire().queuedBehind).toBe(1);
    release();
  });

  it("acquires immediately without a limiter, as solo runs have no queue", async () => {
    const entries: Record<string, unknown>[] = [];
    const acquireSlot = createTransferSlotAcquirer({
      limiter: undefined,
      logger: {
        info: async (entry) => {
          entries.push(entry);
        },
      },
      transfer: "repo-snapshot",
    });

    const release = await acquireSlot();
    release();
    expect(entries).toEqual([]);
  });
});
