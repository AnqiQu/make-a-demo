import { describe, expect, it } from "vitest";
import type { BrowserAction } from "../../pipeline/06-footage-capture/browser-action-plan";
import {
  DEMO_SCRIPT_OUTPUT_PATH,
  readActionCatalog,
  readScriptCandidate,
} from "../schemas/artifacts";
import {
  createDemoScriptContract,
  ensureSceneNavigation,
  validateDemoScriptCandidateContract,
} from "./demo-script-contract";

describe("DemoScriptContract", () => {
  it("passes a valid typed Demo Script candidate grounded in ActionCatalog", () => {
    const report = validateDemoScriptCandidateContract({
      actionCatalog: actionCatalog(),
      flowSpec: flowSpec(),
      preparationManifest: preparationManifest(),
      scriptCandidate: scriptCandidate(validDemoScript()),
    });

    expect(report).toMatchObject({
      failureClassification: "none",
      stage: "static-script-contract-validation",
      status: "passed",
    });
    expect(createDemoScriptContract().outputPath).toBe(DEMO_SCRIPT_OUTPUT_PATH);
    expect(createDemoScriptContract().requiredMetadata).not.toContain(
      "presentation.music",
    );
    expect(createDemoScriptContract().requiredMetadata).not.toContain(
      "presentation.textOverlays",
    );
    expect(createDemoScriptContract().requiredMetadata).not.toContain(
      "presentation.transitions",
    );
  });

  it("publishes a browser-Scene-only JSON Schema and backend-compilation example", () => {
    const contract = createDemoScriptContract();

    expect(contract.jsonSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        format: { const: "16:9" },
        presentation: {
          properties: {
            textOverlays: { maxItems: 40 },
          },
        },
        scenes: {
          items: { properties: { type: { const: "playwright-recording" } } },
          maxItems: 20,
          minItems: 1,
          type: "array",
        },
        setupActions: { maxItems: 50 },
      },
      type: "object",
    });
    // The narrative's intro/outro cards and transitions are backend-owned:
    // offering them to the agent would misdescribe the contract.
    expect(
      (
        contract.jsonSchema as {
          properties: { presentation: { properties: Record<string, unknown> } };
        }
      ).properties.presentation.properties,
    ).not.toHaveProperty("transitions");
    const browserSceneSchema = (
      contract.jsonSchema as {
        properties: {
          scenes: {
            items: {
              properties: {
                actions?: {
                  items: { oneOf: Array<{ required: string[] }> };
                };
              };
            };
          };
        };
      }
    ).properties.scenes.items;
    expect(
      browserSceneSchema?.properties.actions?.items.oneOf.every((schema) =>
        schema.required.includes("sourceActionId"),
      ),
    ).toBe(true);
    expect(
      browserSceneSchema?.properties.actions?.items.oneOf
        .filter((schema) => schema.required.includes("locator"))
        .every((schema) => schema.required.includes("locatorCandidateId")),
    ).toBe(true);
    expect(browserSceneSchema?.properties.actions).toMatchObject({
      contains: {
        properties: {
          type: { enum: ["assert-visible", "assert-text"] },
        },
        required: ["type"],
      },
      minContains: 1,
    });
    const actionSchemas =
      browserSceneSchema?.properties.actions?.items.oneOf ?? [];
    const gotoSchema = actionSchemas.find(
      (schema) =>
        (
          schema as unknown as {
            properties?: { type?: { const?: string } };
          }
        ).properties?.type?.const === "goto",
    ) as unknown as { properties?: { path?: { pattern?: string } } };
    expect(gotoSchema.properties?.path?.pattern).toBe("^(?:/(?!/)|#|\\?).*$");
    expect(contract.jsonSchema).toMatchObject({
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
                },
              },
            },
          },
        },
      ],
    });
    expect(contract.examples[0]).not.toHaveProperty("demoPlaywrightScript");
    expect(contract.examples[0]).toMatchObject({
      scenes: [{ actions: expect.any(Array), type: "playwright-recording" }],
    });
  });

  it("rejects a synthetic-only Demo Script that bypasses the selected browser flow", () => {
    const report = validateDemoScriptCandidateContract({
      actionCatalog: actionCatalog(),
      flowSpec: flowSpec(),
      preparationManifest: preparationManifest(),
      scriptCandidate: scriptCandidate({
        format: "16:9",
        presentation: {},
        scenes: [
          {
            backgroundColor: "#101828",
            durationSeconds: 2,
            id: "title-card",
            text: {
              color: "#ffffff",
              content: "Welcome",
              font: "Inter",
              position: "center",
              size: "large",
            },
            type: "full-screen-text",
          },
        ],
        scriptId: "title-card-demo",
        title: "Title Card Demo",
        version: 1,
      }),
    });

    expect(report).toMatchObject({
      failureClassification: "script contract failure",
      logsSummary: expect.stringContaining(
        "does not cover selected FlowSpec action open-dashboard",
      ),
      status: "failed",
    });
  });

  it("accepts static-image Scenes only when the backend registered the asset ID", () => {
    const staticImageScript = {
      format: "16:9",
      presentation: {},
      scenes: [
        ...validDemoScript().scenes,
        {
          alt: "Product architecture",
          assetId: "architecture-v2.png",
          durationSeconds: 2,
          id: "architecture",
          type: "static-image",
        },
      ],
      scriptId: "architecture-demo",
      title: "Architecture Demo",
      version: 1,
    };
    const input = {
      actionCatalog: actionCatalog(),
      flowSpec: flowSpec(),
      preparationManifest: preparationManifest(),
      scriptCandidate: scriptCandidate(staticImageScript),
    };

    expect(validateDemoScriptCandidateContract(input)).toMatchObject({
      logsSummary: expect.stringContaining(
        "static-image asset architecture-v2.png is not registered",
      ),
      status: "failed",
    });
    expect(
      validateDemoScriptCandidateContract({
        ...input,
        trustedStaticImageAssetIds: ["architecture-v2.png"],
      }),
    ).toMatchObject({ status: "passed" });
  });

  it("requires current browser actions to be backend-compiled and grounded in the selected FlowSpec", () => {
    const typedScript = {
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
              sourceActionId: "dashboard-visible",
              type: "assert-visible",
            },
          ],
          expectedVisibleOutcome: "Dashboard heading is visible.",
          featureId: "dashboard",
          id: "dashboard",
          type: "playwright-recording",
        },
      ],
      scriptId: "script_001",
      title: "Dashboard Demo",
      version: 1,
    };
    const candidate = {
      ...scriptCandidate(typedScript),
      captureSdkVersion: "2026-07-18.1",
      contractVersion: "2026-07-12.1",
    };

    expect(
      validateDemoScriptCandidateContract({
        actionCatalog: actionCatalog(),
        flowSpec: flowSpec(),
        preparationManifest: preparationManifest(),
        scriptCandidate: candidate,
      }),
    ).toMatchObject({ status: "passed" });

    const ungrounded = structuredClone(candidate);
    const firstAction = (
      ungrounded.scriptJsonContent as {
        scenes: Array<{ actions: Array<{ sourceActionId?: string }> }>;
      }
    ).scenes[0]?.actions[0];
    if (firstAction) {
      firstAction.sourceActionId = "invented-action";
    }
    expect(
      validateDemoScriptCandidateContract({
        actionCatalog: actionCatalog(),
        flowSpec: flowSpec(),
        preparationManifest: preparationManifest(),
        scriptCandidate: ungrounded,
      }).logsSummary,
    ).toContain("unknown ActionCatalog action invented-action");
  });

  it("requires every browser Scene to identify the feature it demonstrates", () => {
    const script = structuredClone(validDemoScript()) as {
      scenes: Array<Record<string, unknown>>;
    };
    Reflect.deleteProperty(script.scenes[0] ?? {}, "featureId");

    expect(
      validateDemoScriptCandidateContract({
        actionCatalog: actionCatalog(),
        flowSpec: flowSpec(),
        preparationManifest: preparationManifest(),
        scriptCandidate: scriptCandidate(script),
      }),
    ).toMatchObject({
      logsSummary: expect.stringContaining(
        "Browser Scene dashboard must identify its FlowSpec featureId",
      ),
      status: "failed",
    });
  });

  it("allows grounded off-camera setup actions outside the selected on-camera route", () => {
    const catalog = readActionCatalog(actionCatalog());
    catalog.actions.push({
      confidence: 1,
      evidence: "App exploration",
      expectedResult: "Welcome dialog closes",
      id: "dismiss-welcome",
      kind: "click",
      preferredLocator: {
        name: "Dismiss",
        strategy: "role",
        value: "button",
      },
      risks: [],
      route: "/welcome",
    });

    expect(
      validateDemoScriptCandidateContract({
        actionCatalog: catalog,
        flowSpec: flowSpec(),
        preparationManifest: preparationManifest(),
        scriptCandidate: scriptCandidate({
          ...validDemoScript(),
          setupActions: [
            {
              id: "dismiss-welcome",
              locator: {
                name: "Dismiss",
                role: "button",
                strategy: "role",
              },
              sourceActionId: "dismiss-welcome",
              type: "click",
            },
          ],
        }),
      }),
    ).toMatchObject({ status: "passed" });
  });

  it("rejects evidence-backed on-camera actions that Flow Planning did not select", () => {
    const catalog = actionCatalog();
    catalog.actions.push({
      confidence: 1,
      evidence: "App exploration",
      expectedResult: "Settings opens",
      featureIds: ["dashboard"],
      id: "open-settings",
      kind: "click",
      preferredLocator: {
        name: "Settings",
        strategy: "role",
        value: "button",
      },
      risks: [],
      route: "/",
    });
    const script = structuredClone(validDemoScript()) as unknown as {
      scenes: Array<{ actions: BrowserAction[] }>;
    };
    script.scenes[0]?.actions.splice(1, 0, {
      id: "open-settings",
      locator: {
        name: "Settings",
        role: "button",
        strategy: "role",
      },
      sourceActionId: "open-settings",
      type: "click",
    });

    expect(
      validateDemoScriptCandidateContract({
        actionCatalog: catalog,
        flowSpec: flowSpec(),
        preparationManifest: preparationManifest(),
        scriptCandidate: scriptCandidate(script),
      }),
    ).toMatchObject({
      logsSummary: expect.stringContaining(
        "Browser action open-settings was not selected for FlowSpec feature dashboard",
      ),
      status: "failed",
    });
  });

  it("accepts a concise locator only when it references browser-verified catalog evidence", () => {
    const catalog = readActionCatalog(actionCatalog());
    const sourceAction = catalog.actions[0];
    if (sourceAction === undefined) {
      throw new Error("Expected the dashboard action fixture");
    }
    sourceAction.preferredLocator.name =
      "Open dashboard and inspect recent projects";
    sourceAction.locatorCandidates = [
      {
        id: "open-dashboard-locator-1",
        locator: {
          exact: false,
          name: "Open dashboard",
          role: "button",
          strategy: "role",
        },
        observedAccessibleName: "Open dashboard and inspect recent projects",
        verification: {
          matchCount: 1,
          route: "/",
          visible: true,
        },
      },
    ];
    sourceAction.preferredLocatorCandidateId = "open-dashboard-locator-1";
    const script = structuredClone(validDemoScript()) as unknown as {
      scenes: Array<{ actions: BrowserAction[] }>;
    };
    const firstAction = script.scenes[0]?.actions[0];
    if (firstAction === undefined || !("locator" in firstAction)) {
      throw new Error("Expected the dashboard click fixture");
    }
    firstAction.locator = {
      exact: false,
      name: "Open dashboard",
      role: "button",
      strategy: "role",
    };
    firstAction.locatorCandidateId = "open-dashboard-locator-1";

    expect(
      validateDemoScriptCandidateContract({
        actionCatalog: catalog,
        flowSpec: flowSpec(),
        preparationManifest: preparationManifest(),
        scriptCandidate: scriptCandidate(script),
      }),
    ).toMatchObject({ status: "passed" });
  });

  it("accepts a navigate-grounded goto without requiring FlowSpec selection", () => {
    const catalog = readActionCatalog({
      ...actionCatalog(),
      actions: [...actionCatalog().actions, navigateAction()],
    });
    const script = validDemoScript();
    (
      script.scenes[0]?.actions as unknown as Array<Record<string, unknown>>
    ).unshift({
      id: "dashboard-navigate",
      path: "/",
      sourceActionId: "navigate-dashboard",
      type: "goto",
    });

    expect(
      validateDemoScriptCandidateContract({
        actionCatalog: catalog,
        flowSpec: flowSpec(),
        preparationManifest: preparationManifest(),
        scriptCandidate: scriptCandidate(script),
      }),
    ).toMatchObject({ status: "passed" });
  });

  it("derives the missing Scene navigation from the catalog route", () => {
    const catalog = readActionCatalog({
      ...actionCatalog(),
      actions: [...actionCatalog().actions, navigateAction()],
    });
    const candidate = readScriptCandidate(scriptCandidate(validDemoScript()));

    const augmented = ensureSceneNavigation({
      actionCatalog: catalog,
      scriptCandidate: candidate,
    });

    const scenes = (
      augmented.scriptJsonContent as {
        scenes: Array<{ actions: Array<Record<string, unknown>> }>;
      }
    ).scenes;
    expect(scenes[0]?.actions[0]).toEqual({
      id: "dashboard-navigate",
      path: "/",
      sourceActionId: "navigate-dashboard",
      type: "goto",
    });
    expect(
      validateDemoScriptCandidateContract({
        actionCatalog: catalog,
        flowSpec: flowSpec(),
        preparationManifest: preparationManifest(),
        scriptCandidate: augmented,
      }),
    ).toMatchObject({ status: "passed" });
    expect(
      ensureSceneNavigation({
        actionCatalog: catalog,
        scriptCandidate: augmented,
      }),
    ).toBe(augmented);
  });

  it("leaves a Scene unchanged when its route has no observed navigate action", () => {
    const candidate = readScriptCandidate(scriptCandidate(validDemoScript()));

    expect(
      ensureSceneNavigation({
        actionCatalog: readActionCatalog(actionCatalog()),
        scriptCandidate: candidate,
      }),
    ).toBe(candidate);
  });

  it("rejects a grounded goto action whose target differs from its observed route", () => {
    const catalog = actionCatalog();
    catalog.actions.push({
      confidence: 1,
      evidence: "Playwright loaded the route",
      expectedResult: "Home becomes visible",
      featureIds: ["dashboard"],
      id: "navigate-home",
      kind: "navigate",
      preferredLocator: {
        name: "Home",
        strategy: "role",
        value: "main",
      },
      risks: [],
      route: "/",
    });
    const selectedFlow = flowSpec();
    selectedFlow.features[0]?.referencedActionIds.unshift("navigate-home");
    const script = validDemoScript();
    const actions = script.scenes[0]?.actions as unknown as Array<
      Record<string, unknown>
    >;
    actions.unshift({
      id: "navigate-home",
      path: "/unobserved-admin",
      sourceActionId: "navigate-home",
      type: "goto",
    });

    expect(
      validateDemoScriptCandidateContract({
        actionCatalog: catalog,
        flowSpec: selectedFlow,
        preparationManifest: preparationManifest(),
        scriptCandidate: scriptCandidate(script),
      }),
    ).toMatchObject({
      logsSummary: expect.stringContaining(
        "Browser action navigate-home targets /unobserved-admin but its observed ActionCatalog route is /",
      ),
      status: "failed",
    });
  });

  it("rejects an assert-url action whose target differs from its observed route", () => {
    const catalog = actionCatalog();
    catalog.actions.push({
      confidence: 1,
      evidence: "Playwright observed the dashboard URL",
      expectedResult: "The dashboard URL stays visible",
      featureIds: ["dashboard"],
      id: "assert-dashboard-url",
      kind: "assert",
      preferredLocator: {
        name: "Dashboard",
        strategy: "role",
        value: "main",
      },
      risks: [],
      route: "/dashboard",
    });
    const selectedFlow = flowSpec();
    selectedFlow.features[0]?.referencedActionIds.push("assert-dashboard-url");
    const script = validDemoScript();
    const actions = script.scenes[0]?.actions as unknown as Array<
      Record<string, unknown>
    >;
    actions.push({
      id: "assert-away",
      path: "/unobserved-admin",
      sourceActionId: "assert-dashboard-url",
      type: "assert-url",
    });

    expect(
      validateDemoScriptCandidateContract({
        actionCatalog: catalog,
        flowSpec: selectedFlow,
        preparationManifest: preparationManifest(),
        scriptCandidate: scriptCandidate(script),
      }),
    ).toMatchObject({
      logsSummary: expect.stringContaining(
        "Browser action assert-away targets /unobserved-admin but its observed ActionCatalog route is /dashboard",
      ),
      status: "failed",
    });
  });

  it("accepts placeholder as a grounded locator strategy", () => {
    const catalog = actionCatalog();
    const catalogAction = catalog.actions[0];
    if (catalogAction === undefined) {
      throw new Error("Expected an ActionCatalog fixture action");
    }
    catalogAction.kind = "fill";
    catalogAction.preferredLocator = {
      name: "Search articles",
      strategy: "placeholder",
      value: "Search articles",
    };
    const script = validDemoScript();
    Object.assign(script.scenes[0]?.actions[0] ?? {}, {
      locator: {
        exact: true,
        strategy: "placeholder",
        value: "Search articles",
      },
      locatorCandidateId: "open-dashboard-locator-1",
      type: "fill",
      value: "quarterly results",
    });

    expect(
      validateDemoScriptCandidateContract({
        actionCatalog: catalog,
        flowSpec: flowSpec(),
        preparationManifest: preparationManifest(),
        scriptCandidate: scriptCandidate(script),
      }),
    ).toMatchObject({ status: "passed" });
  });

  it("accepts grounded values and titles that legitimately mention TODO", () => {
    const catalog = actionCatalog();
    const catalogAction = catalog.actions[0];
    if (catalogAction === undefined) {
      throw new Error("Expected an ActionCatalog fixture action");
    }
    catalogAction.kind = "fill";
    const script = validDemoScript();
    script.title = "TodoApp: organize every TODO";
    Object.assign(script.scenes[0]?.actions[0] ?? {}, {
      type: "fill",
      value: "Add a TODO item",
    });

    expect(
      validateDemoScriptCandidateContract({
        actionCatalog: catalog,
        flowSpec: flowSpec(),
        preparationManifest: preparationManifest(),
        scriptCandidate: scriptCandidate(script),
      }),
    ).toMatchObject({ status: "passed" });
  });

  it("fails invalid scripts with typed contract failures", () => {
    const cases: Array<[string, unknown, string]> = [
      [
        "wrong path",
        {
          ...scriptCandidate(validDemoScript()),
          outputPath: "/tmp/demo-script.json",
        },
        "outputPath must be /workspace/.makeademo/demo-script.json",
      ],
      [
        "stale compiler runtime",
        {
          ...scriptCandidate(validDemoScript()),
          browserActionCompilerVersion: "stale",
        },
        "browserActionCompilerVersion must be 2026-07-18.1",
      ],
      [
        "agent-authored Playwright source",
        scriptCandidate({
          ...validDemoScript(),
          demoPlaywrightScript: "await page.goto(baseUrl);",
        }),
        "demoPlaywrightScript is backend-generated",
      ],
      [
        "external URL",
        scriptCandidate({
          ...validDemoScript(),
          setupActions: [
            { id: "leave-app", path: "https://example.com", type: "goto" },
          ],
        }),
        "setupActions[0].path must be a local app path",
      ],
      [
        "ungrounded setup action",
        scriptCandidate({
          ...validDemoScript(),
          setupActions: [
            {
              id: "dismiss-dialog",
              locator: {
                name: "Dismiss",
                role: "button",
                strategy: "role",
              },
              type: "click",
            },
          ],
        }),
        "Browser action dismiss-dialog must include sourceActionId",
      ],
      [
        "missing scene",
        scriptCandidate({ ...validDemoScript(), scenes: [] }),
        "scenes must be a non-empty array",
      ],
      [
        "implicit legacy scene type",
        scriptCandidate({
          ...validDemoScript(),
          scenes: [
            Object.fromEntries(
              Object.entries(validDemoScript().scenes[0] ?? {}).filter(
                ([key]) => key !== "type",
              ),
            ),
          ],
        }),
        "Current Demo Script scenes[0].type is required",
      ],
      [
        "legacy scene description alias",
        scriptCandidate({
          ...validDemoScript(),
          scenes: [
            {
              ...validDemoScript().scenes[0],
              description: "Legacy description",
            },
          ],
        }),
        "Current Demo Script scenes[0].description is not supported",
      ],
      [
        "placeholder",
        scriptCandidate({
          ...validDemoScript(),
          scenes: [
            {
              ...validDemoScript().scenes[0],
              humanReadableDescription: "TODO describe this scene",
            },
          ],
        }),
        "Demo Script must not contain placeholder content",
      ],
    ];

    for (const [label, candidate, reason] of cases) {
      const report = validateDemoScriptCandidateContract({
        actionCatalog: actionCatalog(),
        flowSpec: flowSpec(),
        preparationManifest: preparationManifest(),
        scriptCandidate: candidate,
      });

      expect(report.status, label).toBe("failed");
      expect(report.logsSummary, label).toContain(reason);
      expect(report.failureClassification, label).toBe(
        "script contract failure",
      );
    }
  });
});

function scriptCandidate(scriptJsonContent: unknown) {
  return {
    assumptions: [],
    conformanceResult: {
      artifactReferences: [],
      blockedNetworkAttempts: [],
      browserObservations: [],
      consoleErrors: [],
      logsSummary: "pending",
      networkAttempts: [],
      pageErrors: [],
      retryCount: 0,
      screenshots: [],
      stage: "static-script-contract-validation",
      status: "passed",
      stderrExcerpts: [],
      stdoutExcerpts: [],
      suggestedRepairHints: [],
    },
    browserActionCompilerVersion: "2026-07-18.1",
    bunRuntimeVersion: "1.3.14",
    captureSdkVersion: "2026-07-18.1",
    contractVersion: "2026-07-12.1",
    outputPath: DEMO_SCRIPT_OUTPUT_PATH,
    playwrightRuntimeVersion: "1.60.0",
    scriptJsonContent,
    sourceAppMapId: "appmap_001",
    sourceFlowSpecId: "flow_001",
    sourcePreparationManifestId: "prep_001",
    unsupportedPieces: [],
    validationArtifacts: [],
  };
}

function preparationManifest() {
  return {
    appDir: ".",
    appExplorationHints: [],
    baseUrl: "http://127.0.0.1:3000",
    blockedExternalServicesReplaced: [],
    cleanupAndReproInstructions: [],
    envUsed: {},
    id: "prep_001",
    installCommandUsed: "bun install --frozen-lockfile",
    knownLimitations: [],
    localDemoModeChanges: [],
    mocksAndFixturesAdded: [],
    ports: [3000],
    productContext: {
      evidencePaths: ["package.json"],
      featureInventory: [
        {
          authStrategy: "none",
          description: "Show the dashboard.",
          entryPaths: ["/"],
          fixtureNotes: [],
          id: "dashboard",
          label: "Dashboard",
          requestedFeature: "dashboard",
          sourcePaths: ["package.json"],
        },
      ],
      name: "Demo App",
      summary: "A dashboard application.",
    },
    requiredLocalOnlyAssumptions: [],
    scriptGenerationContext: [],
    startCommandUsed: "bun run dev --host 127.0.0.1 --port 3000",
  };
}

function flowSpec() {
  return {
    features: [
      {
        expectedVisibleAssertions: ["Dashboard heading is visible"],
        featureId: "dashboard",
        label: "Dashboard",
        referencedActionIds: ["open-dashboard", "dashboard-visible"],
        referencedAppMapRoutePaths: ["/"],
        requestedFeature: "dashboard",
        requiredAppState: [],
        selectionReason: "Visible in app map",
        steps: ["Open dashboard"],
      },
    ],
    id: "flow_001",
    repairConstraints: ["Preserve the dashboard assertion"],
    version: 2 as const,
  };
}

function actionCatalog() {
  return {
    actions: [
      {
        confidence: 1,
        evidence: "App exploration",
        expectedResult: "Dashboard opens",
        featureIds: ["dashboard"],
        id: "open-dashboard",
        kind: "click",
        preferredLocator: {
          name: "Open dashboard",
          strategy: "role",
          value: "button",
        },
        risks: [],
        route: "/",
      },
      {
        confidence: 1,
        evidence: "App exploration",
        expectedResult: "Dashboard remains visible",
        featureIds: ["dashboard"],
        id: "dashboard-visible",
        kind: "assert",
        preferredLocator: {
          name: "Dashboard",
          strategy: "role",
          value: "heading",
        },
        risks: [],
        route: "/",
      },
    ],
    appMapId: "appmap_001",
    id: "actions_001",
  };
}

function navigateAction() {
  return {
    confidence: 1,
    evidence: "Playwright loaded /",
    expectedResult: "Dashboard becomes visible",
    featureIds: ["dashboard"],
    id: "navigate-dashboard",
    kind: "navigate",
    preferredLocator: {
      reason: "Navigation actions target an observed route, not an element.",
      strategy: "css",
      value: "body",
    },
    risks: [],
    route: "/",
  };
}

function validDemoScript() {
  return {
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
            sourceActionId: "dashboard-visible",
            type: "assert-visible",
          },
        ],
        expectedVisibleOutcome: "Dashboard heading is visible.",
        featureId: "dashboard",
        humanReadableDescription: "Open the dashboard.",
        id: "dashboard",
        type: "playwright-recording",
      },
    ],
    scriptId: "script_001",
    title: "Dashboard Demo",
    version: 1,
  };
}
