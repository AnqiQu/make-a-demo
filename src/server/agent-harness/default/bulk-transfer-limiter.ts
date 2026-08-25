/**
 * One acquisition of the batch's transfer slot. `queuedBehind` counts the
 * transfers already holding or awaiting the slot when this acquisition
 * joined the queue — the "queued behind N transfers" a run's log must be
 * able to name (N177). `lease` resolves with this acquisition's release
 * function once the slot is free.
 */
type BulkTransferAcquisition = {
  lease: Promise<() => void>;
  queuedBehind: number;
};

/**
 * Serializes bulk network transfers across concurrently running pipeline
 * entries. A matrix batch launches every entry's multi-GB clone and archive
 * upload into the same launch window, and the shared uplink divides so thin
 * that transfers die mid-stream or outlive their attempt bounds (calcom and
 * ghostfolio's clones plus twenty's 294MB upload, 2026-08-13T23-23 batch).
 *
 * Implementations must hand the slot to one acquirer at a time in
 * acquisition order, must report at acquire time how many earlier
 * acquisitions are still unreleased, and must tolerate duplicate release
 * calls without freeing the slot twice. Callers must release every
 * acquired lease; a retrying transfer must re-acquire per attempt so a
 * wedged target never holds the queue through backoff waits or target
 * recreation (N177: one wedged upload's retry-and-recreate arc held the
 * batch's only slot for 46 minutes and starved four runs' setup).
 * Ordinary small transfers (text artifacts, scripts) should not be routed
 * through the limiter — only transfers whose duration is dominated by
 * payload size.
 */
export type BulkTransferLimiter = {
  acquire(): BulkTransferAcquisition;
};

/**
 * Wraps a limiter's slot acquisition with queue visibility for one named
 * transfer: a not-immediately-free slot logs `transfer.queue.waiting` with
 * how many transfers are ahead, and `transfer.queue.acquired` with the
 * waited duration once granted, so a multi-minute pre-transfer gap reads
 * as "queued behind N transfers" in the run's own log instead of silence
 * (N177). The returned acquirer is shaped for per-attempt leasing: call it
 * before each transfer attempt and invoke the released function as soon as
 * the attempt settles. Without a limiter (solo runs) it acquires a no-op
 * immediately and logs nothing; logging failures never displace the
 * acquisition.
 */
export function createTransferSlotAcquirer(options: {
  limiter: BulkTransferLimiter | undefined;
  logger?: { info(entry: Record<string, unknown>): Promise<void> } | undefined;
  now?: () => number;
  transfer: string;
}): () => Promise<() => void> {
  const now = options.now ?? Date.now;
  const logBestEffort = async (entry: Record<string, unknown>) => {
    try {
      await options.logger?.info(entry);
    } catch {
      // Queue visibility must never displace the transfer it describes.
    }
  };
  return async () => {
    if (options.limiter === undefined) {
      return () => {};
    }
    const { lease, queuedBehind } = options.limiter.acquire();
    if (queuedBehind === 0) {
      return lease;
    }
    const queuedAtMs = now();
    await logBestEffort({
      event: "transfer.queue.waiting",
      message: `Bulk transfer ${options.transfer} is queued behind ${queuedBehind} transfer(s) for the batch's shared transfer slot.`,
      queuedBehind,
      transfer: options.transfer,
    });
    const release = await lease;
    const waitedMs = now() - queuedAtMs;
    await logBestEffort({
      event: "transfer.queue.acquired",
      message: `Bulk transfer ${options.transfer} acquired the shared transfer slot after waiting ${waitedMs}ms behind ${queuedBehind} transfer(s).`,
      queuedBehind,
      transfer: options.transfer,
      waitedMs,
    });
    return release;
  };
}

export function createBulkTransferLimiter(): BulkTransferLimiter {
  let unreleased = 0;
  let tail: Promise<void> = Promise.resolve();
  return {
    acquire(): BulkTransferAcquisition {
      const queuedBehind = unreleased;
      unreleased += 1;
      let releaseHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        let released = false;
        releaseHeld = () => {
          if (released) {
            return;
          }
          released = true;
          unreleased -= 1;
          resolve();
        };
      });
      const lease = tail.then(() => releaseHeld);
      tail = lease.then(() => held);
      return { lease, queuedBehind };
    },
  };
}
