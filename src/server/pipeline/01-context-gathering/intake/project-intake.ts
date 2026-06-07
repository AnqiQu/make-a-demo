import { type DemoBrief, readDemoBriefSchema } from "./demo-brief.schema";
import {
  type ProjectIntake,
  readProjectIntakeSchema,
} from "./project-intake.schema";

export function readProjectIntake(value: unknown): ProjectIntake {
  return readProjectIntakeSchema(value);
}

export function readDemoBrief(value: unknown): DemoBrief {
  return readDemoBriefSchema(value);
}
