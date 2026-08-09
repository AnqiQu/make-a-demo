import type { FlowSpec } from "./artifacts";

const requiredFields = [
  "id",
  "features",
  "repairConstraints",
  "version",
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
    contractVersion: "2026-07-12",
    invariants: [
      "features must contain one entry for every maker-requested feature and no unrequested feature entries",
      "when the maker supplied no features, select a small set from PreparationManifest.productContext.featureInventory",
      "every feature must contain at least one concise observable demo step",
      "every feature route must be present in AppMap",
      "every feature action must be present in ActionCatalog and tagged with that featureId",
      "every feature label must preserve the selected PreparationManifest feature label",
      "every feature must select at least one non-assert interaction and at least one visible assertion from ActionCatalog",
      "when ActionCatalog offers an assert on route-distinct visible content for a feature, the feature must select one; assertions on navigation labels repeated across routes do not evidence the feature",
      "the route-distinct preference never overrides the tagged-set requirement: when a feature's only tagged asserts are navigation-flavored, select the best tagged one anyway rather than an assert tagged to another feature",
      "an assert carrying revealedBy targets text that appears only after its revealing interaction: select it together with that interaction (the pair satisfies the route-distinct preference), never with a different interaction",
      "every feature must reference at least one ActionCatalog action not reused by another selected feature",
      "every feature must describe a visible browser outcome",
      "all array fields must be JSON arrays even when they are empty",
    ],
    outputPath: "/workspace/.makeademo/flow-spec.json",
    properties: {
      features: {
        items: {
          additionalProperties: false,
          properties: {
            expectedVisibleAssertions: { ...stringArray, minItems: 1 },
            featureId: {
              minLength: 1,
              pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
              type: "string",
            },
            label: { minLength: 1, type: "string" },
            referencedActionIds: { ...stringArray, minItems: 1 },
            referencedAppMapRoutePaths: { ...stringArray, minItems: 1 },
            requestedFeature: { minLength: 1, type: "string" },
            requiredAppState: stringArray,
            selectionReason: { minLength: 1, type: "string" },
            steps: { ...stringArray, minItems: 1 },
          },
          required: [
            "expectedVisibleAssertions",
            "featureId",
            "label",
            "referencedActionIds",
            "referencedAppMapRoutePaths",
            "requiredAppState",
            "selectionReason",
            "steps",
          ],
          type: "object",
        },
        minItems: 1,
        type: "array",
      },
      id: { minLength: 1, type: "string" },
      repairConstraints: stringArray,
      version: { const: 2 },
    } satisfies Record<keyof FlowSpec, unknown>,
    required: requiredFields,
    type: "object",
  } as const;
}
