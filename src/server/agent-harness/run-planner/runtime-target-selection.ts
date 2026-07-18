import type {
  RepoBrowserRuntimeCandidate,
  RepoProfile,
  RuntimeTargetSelection,
} from "../schemas/artifacts";

const roles = new Set<RuntimeTargetSelection["role"]>([
  "admin",
  "docs",
  "marketing",
  "product",
  "showcase",
  "unknown",
]);

type CandidateAssessment = {
  evidencePaths: string[];
  reason: string;
  role: RuntimeTargetSelection["role"];
  targetId: string;
};

/** Signals that source evidence cannot choose safely without maker input. */
export class RuntimeTargetSelectionRequiredError extends Error {
  readonly candidateIds: string[];

  constructor(reason: string, candidateIds: string[]) {
    super(
      `${reason} Set demoBrief.preferredAppDir to one of: ${candidateIds.join(", ")}.`,
    );
    this.name = "RuntimeTargetSelectionRequiredError";
    this.candidateIds = candidateIds;
  }
}

/** Validates a maker-selected browser application against screened metadata. */
export function createExplicitRuntimeTargetSelection(
  repoProfile: RepoProfile,
  targetId: string,
): RuntimeTargetSelection {
  const candidate = findCandidate(repoProfile, targetId);
  return {
    evidencePaths: candidate.evidencePaths,
    reason: `The maker selected ${targetId} as the application to demonstrate.`,
    role: "unknown",
    source: "explicit",
    targetId,
  };
}

/** Validates the read-only model decision and returns its selected target. */
export function readModelRuntimeTargetSelection(
  value: unknown,
  repoProfile: RepoProfile,
): RuntimeTargetSelection {
  const candidates = repoProfile.browserRuntimeCandidates ?? [];
  const candidateIds = candidates.map(({ dir }) => dir);
  const record = readRecord(value, "Runtime target decision");
  const assessments = readAssessments(record.candidates);
  const assessedIds = assessments.map(({ targetId }) => targetId);
  if (
    assessedIds.length !== candidateIds.length ||
    new Set(assessedIds).size !== assessedIds.length ||
    candidateIds.some((id) => !assessedIds.includes(id))
  ) {
    throw new Error(
      "Runtime target decision must assess every profiled browser application exactly once.",
    );
  }
  for (const assessment of assessments) {
    const candidate = findCandidate(repoProfile, assessment.targetId);
    if (
      assessment.evidencePaths.length === 0 ||
      assessment.evidencePaths.some(
        (path) => !candidate.evidencePaths.includes(path),
      )
    ) {
      throw new Error(
        `Runtime target ${assessment.targetId} must cite its profiled screened evidence paths.`,
      );
    }
  }
  const reason = readString(record.reason, "Runtime target decision.reason");
  if (record.selectedTargetId === null) {
    throw new RuntimeTargetSelectionRequiredError(reason, candidateIds);
  }
  const selectedTargetId = readString(
    record.selectedTargetId,
    "Runtime target decision.selectedTargetId",
  );
  const selected = assessments.find(
    ({ targetId }) => targetId === selectedTargetId,
  );
  if (selected === undefined) {
    throw new Error(
      "Runtime target decision.selectedTargetId must reference an assessed browser application.",
    );
  }
  if (
    ["docs", "marketing", "showcase"].includes(selected.role) &&
    assessments.some(({ role }) => role === "admin" || role === "product")
  ) {
    throw new Error(
      `Runtime target decision selected ${selected.role} application ${selectedTargetId} while a functional product application is available.`,
    );
  }
  return {
    evidencePaths: selected.evidencePaths,
    reason,
    role: selected.role,
    source: "model",
    targetId: selectedTargetId,
  };
}

function readAssessments(value: unknown): CandidateAssessment[] {
  if (!Array.isArray(value)) {
    throw new Error("Runtime target decision.candidates must be an array.");
  }
  return value.map((entry, index) => {
    const path = `Runtime target decision.candidates[${index}]`;
    const record = readRecord(entry, path);
    const role = readString(record.role, `${path}.role`);
    if (!roles.has(role as RuntimeTargetSelection["role"])) {
      throw new Error(`${path}.role is invalid.`);
    }
    if (!Array.isArray(record.evidencePaths)) {
      throw new Error(`${path}.evidencePaths must be an array.`);
    }
    return {
      evidencePaths: record.evidencePaths.map((entry, evidenceIndex) =>
        readString(entry, `${path}.evidencePaths[${evidenceIndex}]`),
      ),
      reason: readString(record.reason, `${path}.reason`),
      role: role as RuntimeTargetSelection["role"],
      targetId: readString(record.targetId, `${path}.targetId`),
    };
  });
}

function findCandidate(
  repoProfile: RepoProfile,
  targetId: string,
): RepoBrowserRuntimeCandidate {
  const candidate = repoProfile.browserRuntimeCandidates?.find(
    ({ dir }) => dir === targetId,
  );
  if (candidate === undefined) {
    throw new Error(
      `Runtime target ${targetId} is not a profiled browser application.`,
    );
  }
  return candidate;
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}
