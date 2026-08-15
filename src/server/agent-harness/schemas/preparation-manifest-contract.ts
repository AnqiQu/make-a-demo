import {
  provisionableServices,
  sandboxServiceConnectionUrls,
} from "../sandbox-services/sandbox-services";
import { type PreparationManifest, dataStrategyRungs } from "./artifacts";

const stringArray = {
  items: { type: "string" },
  type: "array",
} as const;

const repoRelativePathArray = {
  items: { minLength: 1, pattern: "^[^/\\\\]", type: "string" },
  type: "array",
} as const;

const localAppPathArray = {
  items: { minLength: 1, pattern: "^(?:/(?!/)|#|\\?)", type: "string" },
  type: "array",
} as const;

const requiredFields = [
  "appDir",
  "appExplorationHints",
  "baseUrl",
  "blockedExternalServicesReplaced",
  "cleanupAndReproInstructions",
  "envUsed",
  "id",
  "installCommandUsed",
  "knownLimitations",
  "localDemoModeChanges",
  "mocksAndFixturesAdded",
  "ports",
  "productContext",
  "requiredLocalOnlyAssumptions",
  "scriptGenerationContext",
  "startCommandUsed",
] as const satisfies readonly (keyof PreparationManifest)[];

/**
 * Returns the backend-owned contract Repo Preparation must satisfy when
 * writing its durable manifest. Implementations must preserve every required
 * field and fully describe each feature inventory entry in one pass.
 */
export function createPreparationManifestContract() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    invariants: [
      "all paths must reference the screened repository and must not be absolute",
      "every maker-requested feature must appear exactly once and preserve its exact text in requestedFeature",
      "when no features were requested, featureInventory must contain at least three source-backed browser-demonstrable candidates when the product supports them",
      "every feature entry must include every required field, including empty array fields",
      "every feature sourcePaths list must cite an original browser route, page, component, or UI module used by the prepared route",
      "authStrategy must be exactly bypass, demo-identity, or none",
      "when any feature uses bypass or demo-identity, authBypassOrDemoIdentity must describe the active secret-free authentication bootstrap",
      "feature ids must be stable safe identifiers and unique within featureInventory",
      "every data-backed feature must declare its dataSeams: the repo-relative path and functionName of the function the UI calls (now returning the in-code fixture under the demo gate) and the fixtureModule holding the fixture literal; declared files must exist in the prepared diff",
      "every maker-requested feature must declare expectedProof: the typed browser-checkable outcome that proves the feature on its first entry route (visible-text: an exact on-screen string; element-appears: a visible element's accessible name; state-transition: click the control named locator while its state reads from and observe state to)",
      "expectedProof locators, names, and texts are accessible names or on-screen strings — never CSS selectors or XPath",
      "a state-transition proof's from must never be disabled: seed fixture state so the control starts enabled (history pre-populated so Undo is clickable, a followable author whose control will rename)",
      "each feature's first entryPath must be a route no other feature claims",
      "a production-entry startCommandUsed such as node dist/..., node build/..., or node .next/... requires buildCommandUsed to declare the build that emits that entry; when startCommandUsed is npm, yarn, pnpm, or bun run <script>, resolve that script through the repo profile's packageScripts and apply the same production-entry rule; otherwise use the repository's development server",
      `when the repo profile's servicesRequired is non-empty, dataStrategy must declare exactly one entry per detected service (copy the service names from servicesRequired) choosing a currently-provided rung in preference order: embedded-config (preferred when the repo supports an embedded driver such as sqlite — configure and seed it), provisioned-service (a real ${provisionableServices.join(", ")} booted by the harness on loopback), client-stub (serve deterministic fixtures from the app's own fetch/API-client layer, never a service worker), or declared-stub (demo the feature on generated data and describe the substitution in detail); never drop a data-backed feature or steer the demo away from it`,
      "every client-stub or declared-stub dataStrategy entry must be backed in the same manifest by a concrete mocksAndFixturesAdded or localDemoModeChanges entry, or by an active MAKEADEMO_DEMO delivery gate in envUsed; prose that says no fixture adapter was added is not a stub mechanism",
      `on the provisioned-service rung the harness boots the service before the build step and the app must connect through envUsed to exactly ${sandboxServiceConnectionUrls.postgres} for postgres, ${sandboxServiceConnectionUrls.mysql} for mysql, or ${sandboxServiceConnectionUrls.redis} for redis; declare the repo's own migrationCommand and seedCommand (each optional, run in appDir after the service health check and re-run against a reset service on every validation round) so schema and demo data are deterministic`,
      "dataStrategy rung provider-recipe is reserved for backend capabilities that do not exist yet and is rejected today",
    ],
    outputPath: "/workspace/.makeademo/preparation-manifest.json",
    properties: {
      appDir: { minLength: 1, type: "string" },
      appExplorationHints: stringArray,
      authBypassOrDemoIdentity: { minLength: 1, type: "string" },
      baseUrl: {
        minLength: 1,
        pattern:
          "^http://(?:127\\.0\\.0\\.1|localhost|0\\.0\\.0\\.0)(?::\\d+)?(?:/|$)",
        type: "string",
      },
      blockedExternalServicesReplaced: stringArray,
      buildCommandUsed: { type: "string" },
      cleanupAndReproInstructions: stringArray,
      dataStrategy: {
        items: {
          additionalProperties: false,
          properties: {
            detail: { minLength: 1, type: "string" },
            migrationCommand: { minLength: 1, type: "string" },
            rung: { enum: [...dataStrategyRungs], type: "string" },
            seedCommand: { minLength: 1, type: "string" },
            service: { minLength: 1, type: "string" },
          },
          required: ["detail", "rung", "service"],
          type: "object",
        },
        type: "array",
      },
      envUsed: {
        additionalProperties: { type: "string" },
        type: "object",
      },
      id: { minLength: 1, type: "string" },
      installCommandUsed: { minLength: 1, type: "string" },
      knownLimitations: stringArray,
      localDemoModeChanges: stringArray,
      mocksAndFixturesAdded: stringArray,
      ports: {
        items: { maximum: 65_535, minimum: 1, type: "integer" },
        type: "array",
      },
      productContext: {
        additionalProperties: false,
        properties: {
          evidencePaths: repoRelativePathArray,
          featureInventory: {
            items: {
              additionalProperties: false,
              properties: {
                authStrategy: {
                  enum: ["bypass", "demo-identity", "none"],
                  type: "string",
                },
                dataSeams: {
                  items: {
                    additionalProperties: false,
                    properties: {
                      fixtureModule: repoRelativePathArray.items,
                      functionName: { minLength: 1, type: "string" },
                      path: repoRelativePathArray.items,
                      shapeProbe: { minLength: 1, type: "string" },
                    },
                    required: ["fixtureModule", "functionName", "path"],
                    type: "object",
                  },
                  type: "array",
                },
                description: { minLength: 1, type: "string" },
                entryPaths: localAppPathArray,
                expectedProof: {
                  oneOf: [
                    {
                      additionalProperties: false,
                      properties: {
                        kind: { const: "element-appears", type: "string" },
                        name: { minLength: 1, type: "string" },
                      },
                      required: ["kind", "name"],
                      type: "object",
                    },
                    {
                      additionalProperties: false,
                      properties: {
                        from: { minLength: 1, type: "string" },
                        kind: { const: "state-transition", type: "string" },
                        locator: { minLength: 1, type: "string" },
                        to: { minLength: 1, type: "string" },
                      },
                      required: ["from", "kind", "locator", "to"],
                      type: "object",
                    },
                    {
                      additionalProperties: false,
                      properties: {
                        kind: { const: "visible-text", type: "string" },
                        text: { minLength: 1, type: "string" },
                      },
                      required: ["kind", "text"],
                      type: "object",
                    },
                  ],
                },
                fixtureNotes: stringArray,
                id: {
                  minLength: 1,
                  pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
                  type: "string",
                },
                label: { minLength: 1, type: "string" },
                requestedFeature: { minLength: 1, type: "string" },
                sourcePaths: repoRelativePathArray,
              },
              required: [
                "authStrategy",
                "description",
                "entryPaths",
                "fixtureNotes",
                "id",
                "label",
                "sourcePaths",
              ],
              type: "object",
            },
            type: "array",
          },
          name: { minLength: 1, type: "string" },
          summary: { minLength: 1, type: "string" },
        },
        required: ["evidencePaths", "featureInventory", "name", "summary"],
        type: "object",
      },
      requiredLocalOnlyAssumptions: stringArray,
      scriptGenerationContext: stringArray,
      startCommandUsed: { minLength: 1, type: "string" },
    } satisfies Record<keyof PreparationManifest, unknown>,
    required: requiredFields,
    type: "object",
  } as const;
}
