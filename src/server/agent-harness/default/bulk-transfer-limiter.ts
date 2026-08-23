/**
 * Serializes bulk network transfers across concurrently running pipeline
 * entries. A matrix batch launches every entry's multi-GB clone and archive
 * upload into the same launch window, and the shared uplink divides so thin
 * that transfers die mid-stream or outlive their attempt bounds (calcom and
 * ghostfolio's clones plus twenty's 294MB upload, 2026-08-13T23-23 batch).
 *
 * Implementations must run submitted tasks one at a time in submission
 * order, must propagate each task's result or rejection unchanged, and must
 * release the lock after a failure so one dead transfer never wedges the
 * batch. Ordinary small transfers (text artifacts, scripts) should not be
 * routed through the limiter — only transfers whose duration is dominated
 * by payload size.
 */
export type BulkTransferLimiter = {
  run<T>(task: () => Promise<T>): Promise<T>;
};

export function createBulkTransferLimiter(): BulkTransferLimiter {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
