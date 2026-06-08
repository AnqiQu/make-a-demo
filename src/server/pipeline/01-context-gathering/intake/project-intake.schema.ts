export type ProjectIntake = {
  repoUrl: string;
};

export function readProjectIntakeSchema(value: unknown): ProjectIntake {
  const record = assertRecord(value, "Project Intake");
  const repoUrl = readNonEmptyString(record, "repoUrl");

  if (!repoUrl.startsWith("https://github.com/")) {
    throw new Error("repoUrl must be a GitHub HTTPS URL");
  }

  return { repoUrl };
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }

  return value;
}
