import type { RepoProfile } from "../schemas/artifacts";
import type { SubmittedCodeSandboxClass } from "./workspace.interface";

// Wave-9 measurements leave a clean split: Twenty's screened archive was
// 134,113,964 bytes and Calcom exceeded both signals, while Directus had a
// small archive and 42 workspaces. Decimal MB matches the recorded archive
// measurement and keeps Twenty just above the boundary.
const heavyweightArchiveThresholdBytes = 128_000_000;
const heavyweightWorkspacePackageThreshold = 64;

/**
 * Selects submitted-code capacity solely from screened, pre-execution facts.
 * Missing or malformed size evidence stays on the standard class; either a
 * large archive or a broad workspace graph is sufficient for heavyweight.
 */
export function selectSubmittedCodeSandboxClass(
  repoProfile: Pick<RepoProfile, "archiveSizeBytes" | "workspacePackages">,
): SubmittedCodeSandboxClass {
  const archiveSizeBytes = repoProfile.archiveSizeBytes;
  const hasHeavyweightArchive =
    Number.isFinite(archiveSizeBytes) &&
    (archiveSizeBytes ?? -1) >= heavyweightArchiveThresholdBytes;
  const hasHeavyweightWorkspaceGraph =
    (repoProfile.workspacePackages?.length ?? 0) >=
    heavyweightWorkspacePackageThreshold;

  return hasHeavyweightArchive || hasHeavyweightWorkspaceGraph
    ? "heavyweight"
    : "standard";
}
