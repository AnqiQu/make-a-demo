import type { PreparationWorkspace } from "./preparation-workspace.interface";

export type PreparationWorkspaceHandle = {
  destroy(): Promise<void>;
  id: string;
  workspace: PreparationWorkspace;
};

/**
 * Provisions ephemeral workspaces for Repo Preparation.
 * Implementations should hide provider-specific lifecycle, execution, logging,
 * network-policy, and teardown details behind this product-level seam.
 */
export interface PreparationWorkspaceProvider {
  create(): Promise<PreparationWorkspaceHandle>;
}

export type PreparationWorkspaceRunResult<T> =
  | { status: "succeeded"; value: T }
  | { reason: string; status: "failed" | "timed-out" };

export async function runInPreparationWorkspace<T>(input: {
  provider: PreparationWorkspaceProvider;
  run: (handle: PreparationWorkspaceHandle) => Promise<T>;
  timeoutMs: number;
}): Promise<PreparationWorkspaceRunResult<T>> {
  const handle = await input.provider.create();

  try {
    const result = await raceWithTimeout(input.run(handle), input.timeoutMs);
    if (result.status === "timed-out") {
      await handle.workspace.setOutboundNetworkAccess(false);
      return result;
    }

    return result;
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: "failed",
    };
  } finally {
    await handle.destroy();
  }
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<PreparationWorkspaceRunResult<T>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve({
        reason: `Repo Preparation agent timed out after ${timeoutMs}ms.`,
        status: "timed-out",
      });
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve({ status: "succeeded", value });
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
