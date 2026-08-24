import {
  assertRecord,
  readNonEmptyString,
} from "../../../shared/artifact-storage/persisted-record-readers";

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
