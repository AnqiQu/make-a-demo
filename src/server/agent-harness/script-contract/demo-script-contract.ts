import {
  type BrowserAction,
  type BrowserLocator,
  createBrowserActionJsonSchema,
} from "../../pipeline/06-footage-capture/browser-action-plan";
import {
  BROWSER_ACTION_COMPILER_VERSION,
  BUN_RUNTIME_VERSION,
  CAPTURE_SDK_CONTRACT_VERSION,
  DEMO_SCRIPT_CONTRACT_VERSION,
  PLAYWRIGHT_RUNTIME_VERSION,
} from "../../pipeline/06-footage-capture/capture-contract-versions";
import { assertDemoScriptCaptureSdkContract } from "../../pipeline/06-footage-capture/capture-sdk-contract";
import {
  approvedFontFamilies,
  approvedMusicTrackIds,
  demoScriptLimits,
  parseDemoScript,
} from "../../pipeline/06-footage-capture/demo-script.schema";
import {
  type ActionCatalog,
  DEMO_SCRIPT_OUTPUT_PATH,
  type DemoScriptContract,
  type FlowSpec,
  type PreparationManifest,
  type ScriptCandidate,
  type ValidationReport,
  readActionCatalog,
  readFlowSpec,
  readPreparationManifest,
  readScriptCandidate,
  readValidationReport,
} from "../schemas/artifacts";
import { assertCaptureReadyScriptQuality } from "./script-quality";

const externalUrlPattern =
  /https?:\/\/(?!(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d{1,5})?(?:[/'"`\s)]|$))[^\s'"`)]+/i;
const placeholderPattern =
  /\b(?:TODO|FIXME|replace-me|example\.com|lorem ipsum|placeholder)\b/i;

export function createDemoScriptContract(
  options: { trustedStaticImageAssetIds?: readonly string[] } = {},
): DemoScriptContract {
  const trustedStaticImageAssetIds = [
    ...new Set(options.trustedStaticImageAssetIds ?? []),
  ];
  const browserActionSchema = createBrowserActionJsonSchema();
  const groundedBrowserActionItems = {
    oneOf: browserActionSchema.items.oneOf.map((actionSchema) => ({
      ...actionSchema,
      required: [
        ...actionSchema.required,
        "sourceActionId",
        ...(actionSchema.required.includes("locator")
          ? ["locatorCandidateId"]
          : []),
      ],
    })),
  };
  const browserActions = {
    ...browserActionSchema,
    contains: {
      properties: {
        type: { enum: ["assert-visible", "assert-text"] },
      },
      required: ["type"],
      type: "object",
    },
    items: groundedBrowserActionItems,
    maxItems: demoScriptLimits.maxActionsPerCollection,
    minContains: 1,
    minItems: 1,
  };
  const safeId = {
    pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
    type: "string",
  } as const;
  const sceneId = {
    ...safeId,
    pattern: "^(?!setup$)[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
  } as const;
  const description = { minLength: 1, type: "string" } as const;
  const font = {
    enum: approvedFontFamilies,
  } as const;
  const textStyle = {
    additionalProperties: false,
    properties: {
      color: { pattern: "^#[0-9a-fA-F]{6}$", type: "string" },
      content: description,
      font,
      position: { enum: ["bottom-left", "center", "top-left"] },
      size: { enum: ["large", "medium", "small"] },
    },
    required: ["color", "content", "font", "position", "size"],
    type: "object",
  } as const;
  const sceneBaseProperties = {
    humanReadableDescription: description,
    id: sceneId,
  } as const;
  const transitionSceneIds = {
    fromSceneId: sceneId,
    toSceneId: sceneId,
  } as const;
  const jsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    allOf: [
      {
        if: { required: ["setupActions"] },
        // biome-ignore lint/suspicious/noThenProperty: `then` is a JSON Schema conditional keyword.
        then: {
          properties: {
            scenes: {
              contains: {
                properties: {
                  type: { const: "playwright-recording" },
                },
                required: ["type"],
                type: "object",
              },
              minContains: 1,
            },
          },
        },
      },
    ],
    properties: {
      format: { const: "16:9" },
      presentation: {
        additionalProperties: false,
        properties: {
          music: {
            oneOf: [
              {
                additionalProperties: false,
                properties: { enabled: { const: false } },
                required: ["enabled"],
                type: "object",
              },
              {
                additionalProperties: false,
                properties: {
                  enabled: { const: true },
                  trackId: {
                    enum: approvedMusicTrackIds,
                  },
                },
                required: ["enabled", "trackId"],
                type: "object",
              },
            ],
          },
          textOverlays: {
            items: {
              additionalProperties: false,
              properties: {
                content: description,
                font,
                position: { enum: ["bottom-left", "center", "top-left"] },
                sceneId,
                size: { enum: ["large", "medium", "small"] },
              },
              required: ["content", "font", "position", "sceneId", "size"],
              type: "object",
            },
            maxItems: demoScriptLimits.maxTextOverlays,
            type: "array",
          },
          transitions: {
            items: {
              oneOf: [
                {
                  additionalProperties: false,
                  properties: {
                    ...transitionSceneIds,
                    style: { const: "cut" },
                  },
                  required: ["fromSceneId", "style", "toSceneId"],
                  type: "object",
                },
                {
                  additionalProperties: false,
                  properties: {
                    durationSeconds: {
                      maximum: demoScriptLimits.maxFadeDurationSeconds,
                      minimum: demoScriptLimits.minFadeDurationSeconds,
                      type: "number",
                    },
                    ...transitionSceneIds,
                    style: { const: "fade" },
                  },
                  required: [
                    "durationSeconds",
                    "fromSceneId",
                    "style",
                    "toSceneId",
                  ],
                  type: "object",
                },
              ],
            },
            maxItems: demoScriptLimits.maxTransitions,
            type: "array",
          },
        },
        type: "object",
      },
      scenes: {
        items: {
          oneOf: [
            {
              additionalProperties: false,
              properties: {
                actions: browserActions,
                expectedVisibleOutcome: description,
                ...sceneBaseProperties,
                type: { const: "playwright-recording" },
              },
              required: ["actions", "expectedVisibleOutcome", "id", "type"],
              type: "object",
            },
            {
              additionalProperties: false,
              properties: {
                backgroundColor: {
                  pattern: "^#[0-9a-fA-F]{6}$",
                  type: "string",
                },
                durationSeconds: {
                  maximum: demoScriptLimits.maxSyntheticSceneDurationSeconds,
                  minimum: demoScriptLimits.minSyntheticSceneDurationSeconds,
                  type: "number",
                },
                ...sceneBaseProperties,
                text: textStyle,
                type: { const: "full-screen-text" },
              },
              required: [
                "backgroundColor",
                "durationSeconds",
                "id",
                "text",
                "type",
              ],
              type: "object",
            },
            ...(trustedStaticImageAssetIds.length === 0
              ? []
              : [
                  {
                    additionalProperties: false,
                    properties: {
                      alt: description,
                      assetId: {
                        enum: trustedStaticImageAssetIds,
                        type: "string",
                      },
                      durationSeconds: {
                        maximum:
                          demoScriptLimits.maxSyntheticSceneDurationSeconds,
                        minimum:
                          demoScriptLimits.minSyntheticSceneDurationSeconds,
                        type: "number",
                      },
                      ...sceneBaseProperties,
                      type: { const: "static-image" },
                    },
                    required: [
                      "alt",
                      "assetId",
                      "durationSeconds",
                      "id",
                      "type",
                    ],
                    type: "object",
                  } as const,
                ]),
          ],
        },
        maxItems: demoScriptLimits.maxScenes,
        minItems: 1,
        type: "array",
      },
      scriptId: safeId,
      setupActions: {
        ...createBrowserActionJsonSchema(),
        items: groundedBrowserActionItems,
        maxItems: demoScriptLimits.maxActionsPerCollection,
      },
      title: description,
      version: { const: 1 },
    },
    required: [
      "format",
      "presentation",
      "scenes",
      "scriptId",
      "title",
      "version",
    ],
    type: "object",
  } as const;
  const examples = [
    {
      format: "16:9",
      presentation: {},
      scenes: [
        {
          actions: [
            {
              id: "open-dashboard",
              locator: {
                name: "Open dashboard",
                role: "button",
                strategy: "role",
              },
              locatorCandidateId: "open-dashboard-locator-1",
              sourceActionId: "open-dashboard",
              type: "click",
            },
            {
              id: "dashboard-visible",
              locator: {
                name: "Dashboard",
                role: "heading",
                strategy: "role",
              },
              locatorCandidateId: "dashboard-visible-locator-1",
              sourceActionId: "dashboard-visible",
              type: "assert-visible",
            },
          ],
          expectedVisibleOutcome: "The Dashboard heading is visible.",
          id: "dashboard",
          type: "playwright-recording",
        },
        {
          backgroundColor: "#101828",
          durationSeconds: 2.5,
          id: "summary",
          text: {
            color: "#ffffff",
            content: "Ready to build",
            font: "Inter",
            position: "center",
            size: "large",
          },
          type: "full-screen-text",
        },
      ],
      scriptId: "dashboard-demo",
      title: "Dashboard Demo",
      version: 1,
    },
  ];

  return {
    allowedCaptureSdkActions: [
      "setup",
      "scene",
      "step",
      "page.goto",
      "page.locator",
      "page.getByRole",
      "page.getByLabel",
      "page.getByText",
      "page.getByPlaceholder",
      "page.getByTestId",
      "locator.click",
      "locator.hover",
      "locator.fill",
      "locator.press",
      "locator.selectOption",
      "expect(locator).toBeVisible",
      "expect(locator).toContainText",
      "expect(page).toHaveTitle",
      "expect(page).toHaveURL",
    ],
    baseUrlBinding:
      "Capture SDK context baseUrl from PreparationManifest.baseUrl",
    browserContextOwnership:
      "MakeADemo owns browser launch and browser context",
    captureSdkVersion: CAPTURE_SDK_CONTRACT_VERSION,
    contractVersion: DEMO_SCRIPT_CONTRACT_VERSION,
    examples,
    forbiddenApis: [
      "fetch",
      "XMLHttpRequest",
      "WebSocket",
      "EventSource",
      "navigator.sendBeacon",
      "page.request",
      "page.route",
      "page.waitForRequest",
      "page.waitForResponse",
      "chromium.launch",
      "browser.newContext",
      "recordVideo",
    ],
    forbiddenExternalUrls: true,
    forbiddenFields: ["agent-authored demoPlaywrightScript"],
    networkRestrictions: [
      "runtime network is blocked",
      "browser external requests are blocked during validation and capture",
    ],
    outputPath: DEMO_SCRIPT_OUTPUT_PATH,
    requiredAssertions: [
      "assert-visible or assert-text in every playwright-recording Scene",
    ],
    jsonSchema,
    requiredJsonShape: [
      "scriptId",
      "title",
      "version",
      "format",
      "scenes",
      "presentation",
    ],
    requiredMetadata: [],
    timingConventions: [
      "bounded waits only",
      "browser Scene durations are measured from capture markers",
      "synthetic Scene durations are bounded schema fields",
    ],
  };
}

export function validateDemoScriptCandidateContract(input: {
  actionCatalog?: unknown;
  flowSpec: unknown;
  preparationManifest: unknown;
  scriptCandidate: unknown;
  trustedStaticImageAssetIds?: readonly string[];
}): ValidationReport {
  try {
    const preparationManifest = readPreparationManifest(
      input.preparationManifest,
    );
    const flowSpec = readFlowSpec(input.flowSpec);
    const scriptCandidate = readScriptCandidate(input.scriptCandidate);
    assertCandidateReferencesCurrentArtifacts({
      flowSpec,
      preparationManifest,
      scriptCandidate,
    });
    const demoScript = parseDemoScript(scriptCandidate.scriptJsonContent);
    assertCurrentContractGrounding({
      actionCatalog: input.actionCatalog,
      demoScript,
      flowSpec,
      scriptCandidate,
      trustedStaticImageAssetIds: input.trustedStaticImageAssetIds ?? [],
    });
    assertDemoScriptCaptureSdkContract(demoScript);
    assertCaptureReadyScriptQuality(demoScript);
    if (demoScript.demoPlaywrightScript !== undefined) {
      assertUsesManifestBaseUrl(demoScript.demoPlaywrightScript);
      assertNoExternalUrls(demoScript.demoPlaywrightScript);
    }
    assertNoPlaceholders(scriptCandidate.scriptJsonContent);

    return readValidationReport({
      artifactReferences: [DEMO_SCRIPT_OUTPUT_PATH],
      blockedNetworkAttempts: [],
      browserObservations: [],
      consoleErrors: [],
      failureClassification: "none",
      logsSummary: "Demo Script satisfies the static contract.",
      networkAttempts: [],
      pageErrors: [],
      retryCount: 0,
      screenshots: [],
      stage: "static-script-contract-validation",
      status: "passed",
      stderrExcerpts: [],
      stdoutExcerpts: [],
      suggestedRepairHints: [],
      urlChecked: preparationManifest.baseUrl,
    });
  } catch (error) {
    return readValidationReport({
      artifactReferences: [DEMO_SCRIPT_OUTPUT_PATH],
      blockedNetworkAttempts: [],
      browserObservations: [],
      consoleErrors: [],
      failureClassification: "script contract failure",
      logsSummary: error instanceof Error ? error.message : String(error),
      networkAttempts: [],
      pageErrors: [],
      retryCount: 0,
      screenshots: [],
      stage: "static-script-contract-validation",
      status: "failed",
      stderrExcerpts: [],
      stdoutExcerpts: [],
      suggestedRepairHints: [
        "Regenerate /workspace/.makeademo/demo-script.json against the DemoScriptContract.",
      ],
    });
  }
}

function assertCurrentContractGrounding(input: {
  actionCatalog: unknown;
  demoScript: ReturnType<typeof parseDemoScript>;
  flowSpec: FlowSpec;
  scriptCandidate: ScriptCandidate;
  trustedStaticImageAssetIds: readonly string[];
}): void {
  if (input.scriptCandidate.contractVersion !== DEMO_SCRIPT_CONTRACT_VERSION) {
    throw new Error(
      `ScriptCandidate contractVersion must be ${DEMO_SCRIPT_CONTRACT_VERSION}`,
    );
  }
  if (
    input.scriptCandidate.captureSdkVersion !== CAPTURE_SDK_CONTRACT_VERSION
  ) {
    throw new Error(
      `ScriptCandidate captureSdkVersion must be ${CAPTURE_SDK_CONTRACT_VERSION}`,
    );
  }
  if (
    input.scriptCandidate.browserActionCompilerVersion !==
    BROWSER_ACTION_COMPILER_VERSION
  ) {
    throw new Error(
      `ScriptCandidate browserActionCompilerVersion must be ${BROWSER_ACTION_COMPILER_VERSION}`,
    );
  }
  if (input.scriptCandidate.bunRuntimeVersion !== BUN_RUNTIME_VERSION) {
    throw new Error(
      `ScriptCandidate bunRuntimeVersion must be ${BUN_RUNTIME_VERSION}`,
    );
  }
  if (
    input.scriptCandidate.playwrightRuntimeVersion !==
    PLAYWRIGHT_RUNTIME_VERSION
  ) {
    throw new Error(
      `ScriptCandidate playwrightRuntimeVersion must be ${PLAYWRIGHT_RUNTIME_VERSION}`,
    );
  }
  const sourceRecord = assertObject(
    input.scriptCandidate.scriptJsonContent,
    "Demo Script",
  );
  if ("demoPlaywrightScript" in sourceRecord) {
    throw new Error(
      "Current Demo Scripts must provide typed browser actions; demoPlaywrightScript is backend-generated",
    );
  }
  assertCurrentSceneSourceShape(sourceRecord.scenes);
  assertTrustedStaticImageAssets(
    input.demoScript,
    input.trustedStaticImageAssetIds,
  );

  const browserScenes = input.demoScript.scenes.filter(
    (scene) => scene.type === "playwright-recording",
  );
  if (browserScenes.length === 0) {
    const selectedActionId = input.flowSpec.referencedActionIds[0];
    if (selectedActionId !== undefined) {
      throw new Error(
        `Demo Script does not cover selected FlowSpec action ${selectedActionId}`,
      );
    }
    const selectedRoute = input.flowSpec.referencedAppMapRoutePaths[0];
    if (selectedRoute !== undefined) {
      throw new Error(
        `Demo Script does not cover selected FlowSpec route ${selectedRoute}`,
      );
    }
    return;
  }
  const actionCatalog = readActionCatalog(input.actionCatalog);
  if (input.scriptCandidate.sourceAppMapId !== actionCatalog.appMapId) {
    throw new Error(
      "ScriptCandidate must reference the AppMap used by ActionCatalog",
    );
  }
  assertBrowserActionsGrounded({
    actionCatalog,
    browserScenes,
    flowSpec: input.flowSpec,
    setupActions: input.demoScript.setupActions ?? [],
  });
}

function assertTrustedStaticImageAssets(
  demoScript: ReturnType<typeof parseDemoScript>,
  trustedAssetIds: readonly string[],
): void {
  const trusted = new Set(trustedAssetIds);
  for (const scene of demoScript.scenes) {
    if (scene.type === "static-image" && !trusted.has(scene.assetId)) {
      throw new Error(
        `static-image asset ${scene.assetId} is not registered by the backend`,
      );
    }
  }
}

function assertCurrentSceneSourceShape(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("Current Demo Script scenes must be an array");
  }
  for (const [index, scene] of value.entries()) {
    const sceneRecord = assertObject(
      scene,
      `Current Demo Script scenes[${index}]`,
    );
    if (sceneRecord.type === undefined) {
      throw new Error(`Current Demo Script scenes[${index}].type is required`);
    }
    if ("description" in sceneRecord) {
      throw new Error(
        `Current Demo Script scenes[${index}].description is not supported; use humanReadableDescription`,
      );
    }
  }
}

function assertBrowserActionsGrounded(input: {
  actionCatalog: ActionCatalog;
  browserScenes: Array<
    Extract<
      ReturnType<typeof parseDemoScript>["scenes"][number],
      { type: "playwright-recording" }
    >
  >;
  flowSpec: FlowSpec;
  setupActions: BrowserAction[];
}): void {
  const catalogActionsById = new Map(
    input.actionCatalog.actions.map((action) => [action.id, action]),
  );
  const sourceActionIds = new Set<string>();

  for (const scene of input.browserScenes) {
    if (scene.actions === undefined || scene.actions.length === 0) {
      throw new Error(
        `Current browser Scene ${scene.id} must contain typed actions`,
      );
    }
    for (const action of scene.actions) {
      const sourceAction = readGroundedCatalogAction(
        action,
        catalogActionsById,
      );
      assertActionMatchesCatalog(action, sourceAction, input.flowSpec, true);
      sourceActionIds.add(sourceAction.id);
    }
  }

  for (const action of input.setupActions) {
    const sourceAction = readGroundedCatalogAction(action, catalogActionsById);
    assertActionMatchesCatalog(action, sourceAction, input.flowSpec, false);
  }

  for (const actionId of input.flowSpec.referencedActionIds) {
    if (!sourceActionIds.has(actionId)) {
      throw new Error(
        `Demo Script does not cover selected FlowSpec action ${actionId}`,
      );
    }
  }
}

function readGroundedCatalogAction(
  action: BrowserAction,
  catalogActionsById: Map<string, ActionCatalog["actions"][number]>,
): ActionCatalog["actions"][number] {
  if (action.sourceActionId === undefined) {
    throw new Error(
      `Browser action ${action.id} must include sourceActionId grounded in ActionCatalog`,
    );
  }
  const sourceAction = catalogActionsById.get(action.sourceActionId);
  if (sourceAction === undefined) {
    throw new Error(
      `Browser action ${action.id} references unknown ActionCatalog action ${action.sourceActionId}`,
    );
  }
  return sourceAction;
}

function assertActionMatchesCatalog(
  action: BrowserAction,
  sourceAction: ActionCatalog["actions"][number],
  flowSpec: FlowSpec,
  requireSelectedRoute: boolean,
): void {
  const compatibleKinds = compatibleCatalogKinds(action.type);
  if (!compatibleKinds.includes(sourceAction.kind)) {
    throw new Error(
      `Browser action ${action.id} type ${action.type} does not match ActionCatalog kind ${sourceAction.kind}`,
    );
  }
  if (action.type === "goto" && action.path !== sourceAction.route) {
    throw new Error(
      `Browser action ${action.id} targets ${action.path} but its observed ActionCatalog route is ${sourceAction.route}`,
    );
  }
  if (
    requireSelectedRoute &&
    !flowSpec.referencedAppMapRoutePaths.includes(sourceAction.route)
  ) {
    throw new Error(
      `Browser action ${action.id} uses ActionCatalog route ${sourceAction.route} outside the selected FlowSpec`,
    );
  }
  if (
    requireSelectedRoute &&
    !flowSpec.referencedActionIds.includes(sourceAction.id)
  ) {
    throw new Error(`Browser action ${action.id} was not selected by FlowSpec`);
  }
  if ("locator" in action) {
    if (
      sourceAction.locatorCandidates !== undefined &&
      sourceAction.locatorCandidates.length > 0
    ) {
      if (action.locatorCandidateId === undefined) {
        throw new Error(
          `Browser action ${action.id} must reference a browser-verified locatorCandidateId`,
        );
      }
      const candidate = sourceAction.locatorCandidates.find(
        (entry) => entry.id === action.locatorCandidateId,
      );
      if (candidate === undefined) {
        throw new Error(
          `Browser action ${action.id} references unknown locator candidate ${action.locatorCandidateId}`,
        );
      }
      if (candidate.verification.route !== sourceAction.route) {
        throw new Error(
          `Locator candidate ${candidate.id} was verified on ${candidate.verification.route}, not ActionCatalog route ${sourceAction.route}`,
        );
      }
      if (!browserLocatorsEqual(action.locator, candidate.locator)) {
        throw new Error(
          `Browser action ${action.id} locator does not match browser-verified candidate ${candidate.id}`,
        );
      }
    } else {
      assertLocatorMatchesCatalog(
        action.id,
        action.locator,
        sourceAction.preferredLocator,
      );
    }
  }
}

function browserLocatorsEqual(
  actual: BrowserLocator,
  expected: BrowserLocator,
): boolean {
  if (actual.strategy !== expected.strategy) {
    return false;
  }
  if (actual.strategy === "role" && expected.strategy === "role") {
    return (
      actual.role === expected.role &&
      actual.name === expected.name &&
      (actual.exact ?? false) === (expected.exact ?? false)
    );
  }
  if (
    (actual.strategy === "label" ||
      actual.strategy === "placeholder" ||
      actual.strategy === "text") &&
    (expected.strategy === "label" ||
      expected.strategy === "placeholder" ||
      expected.strategy === "text")
  ) {
    return (
      actual.strategy === expected.strategy &&
      actual.value === expected.value &&
      (actual.exact ?? false) === (expected.exact ?? false)
    );
  }
  return (
    "value" in actual && "value" in expected && actual.value === expected.value
  );
}

function compatibleCatalogKinds(
  type: BrowserAction["type"],
): Array<ActionCatalog["actions"][number]["kind"]> {
  if (type === "click") {
    return ["click"];
  }
  if (type === "fill" || type === "press") {
    return ["fill"];
  }
  if (type === "select-option") {
    return ["select"];
  }
  if (type === "goto") {
    return ["navigate"];
  }
  if (type === "hover") {
    return ["wait"];
  }
  return ["assert"];
}

function assertLocatorMatchesCatalog(
  actionId: string,
  locator: BrowserLocator,
  expected: ActionCatalog["actions"][number]["preferredLocator"],
): void {
  const matches =
    locator.strategy === expected.strategy &&
    (locator.strategy === "role"
      ? locator.role === expected.value && locator.name === expected.name
      : locator.value === expected.value);
  if (!matches) {
    throw new Error(
      `Browser action ${actionId} locator does not match its ActionCatalog evidence`,
    );
  }
}

function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertCandidateReferencesCurrentArtifacts(input: {
  flowSpec: FlowSpec;
  preparationManifest: PreparationManifest;
  scriptCandidate: ScriptCandidate;
}): void {
  if (input.scriptCandidate.sourceFlowSpecId !== input.flowSpec.id) {
    throw new Error("ScriptCandidate must reference the current FlowSpec id");
  }
  if (
    input.scriptCandidate.sourcePreparationManifestId !==
    input.preparationManifest.id
  ) {
    throw new Error(
      "ScriptCandidate must reference the current PreparationManifest id",
    );
  }
}

function assertUsesManifestBaseUrl(script: string): void {
  if (!/\bbaseUrl\b/.test(script)) {
    throw new Error("demoPlaywrightScript must use the Capture SDK baseUrl");
  }
}

function assertNoExternalUrls(script: string): void {
  const match = externalUrlPattern.exec(script);
  if (match !== null) {
    throw new Error("demoPlaywrightScript must not reference external URLs");
  }
}

function assertNoPlaceholders(scriptJsonContent: unknown): void {
  const serialized = JSON.stringify(scriptJsonContent);
  if (placeholderPattern.test(serialized)) {
    throw new Error("Demo Script must not contain placeholder content");
  }
}
