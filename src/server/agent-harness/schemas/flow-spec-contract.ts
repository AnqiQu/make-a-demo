import type { FlowSpec } from "./artifacts";

const requiredFields = [
  "id",
  "objective",
  "selectedFlowName",
  "whySelected",
  "userDemoBriefFeaturesCovered",
  "steps",
  "referencedAppMapRoutePaths",
  "referencedActionIds",
  "expectedVisibleAssertions",
  "requiredAppState",
  "skippedOrBlockedFlows",
  "locatorStrategyNotes",
  "repairConstraints",
] as const satisfies readonly (keyof FlowSpec)[];

const stringArray = {
  items: { type: "string" },
  type: "array",
} as const;

/**
 * Returns the backend-owned contract that Flow Planning must use when writing
 * the durable FlowSpec artifact. The contract intentionally is not itself a
 * valid FlowSpec, so an agent cannot pass validation by copying it unchanged.
 */
export function createFlowSpecContract() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    contractVersion: "2026-07-10",
    invariants: [
      "steps must contain at least one concise observable demo step",
      "referencedAppMapRoutePaths must only contain paths present in AppMap",
      "referencedActionIds must only contain IDs present in ActionCatalog",
      "expectedVisibleAssertions must describe visible browser outcomes",
      "all array fields must be JSON arrays even when they are empty",
    ],
    outputPath: "/workspace/.makeademo/flow-spec.json",
    properties: {
      expectedVisibleAssertions: stringArray,
      id: { minLength: 1, type: "string" },
      locatorStrategyNotes: stringArray,
      objective: { minLength: 1, type: "string" },
      referencedActionIds: stringArray,
      referencedAppMapRoutePaths: stringArray,
      repairConstraints: stringArray,
      requiredAppState: stringArray,
      selectedFlowName: { minLength: 1, type: "string" },
      skippedOrBlockedFlows: {
        items: {
          additionalProperties: false,
          properties: {
            flow: { minLength: 1, type: "string" },
            reason: { minLength: 1, type: "string" },
          },
          required: ["flow", "reason"],
          type: "object",
        },
        type: "array",
      },
      steps: { ...stringArray, minItems: 1 },
      userDemoBriefFeaturesCovered: stringArray,
      whySelected: { minLength: 1, type: "string" },
    } satisfies Record<keyof FlowSpec, unknown>,
    required: requiredFields,
    type: "object",
  } as const;
}
