import { describe, expect, it } from "vitest";
import { DEMO_SCRIPT_OUTPUT_PATH } from "../schemas/artifacts";
import {
  createDemoScriptContract,
  validateDemoScriptCandidateContract,
} from "./demo-script-contract";

describe("DemoScriptContract", () => {
  it("passes a valid demo-script.json candidate that uses the Capture SDK and manifest baseUrl", () => {
    const report = validateDemoScriptCandidateContract({
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
        "missing baseUrl",
        scriptCandidate({
          ...validDemoScript(),
          demoPlaywrightScript:
            validDemoScript().demoPlaywrightScript.replaceAll("baseUrl", "url"),
        }),
        "demoPlaywrightScript must use the Capture SDK baseUrl",
      ],
      [
        "external URL",
        scriptCandidate({
          ...validDemoScript(),
          demoPlaywrightScript: validDemoScript().demoPlaywrightScript.replace(
            "await page.goto(baseUrl);",
            "await page.goto('https://example.com');",
          ),
        }),
        "demoPlaywrightScript must not reference external URLs",
      ],
      [
        "forbidden network API",
        scriptCandidate({
          ...validDemoScript(),
          demoPlaywrightScript: validDemoScript().demoPlaywrightScript.replace(
            "await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();",
            "await fetch('https://analytics.example.com');\n  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();",
          ),
        }),
        "Generated Demo Scripts must not call fetch",
      ],
      [
        "missing scene",
        scriptCandidate({ ...validDemoScript(), scenes: [] }),
        "scenes must be a non-empty array",
      ],
      [
        "placeholder",
        scriptCandidate({
          ...validDemoScript(),
          title: "TODO replace-me",
        }),
        "Demo Script must not contain placeholder content",
      ],
    ];

    for (const [label, candidate, reason] of cases) {
      const report = validateDemoScriptCandidateContract({
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
    contractVersion: "2026-07-08",
    outputPath: DEMO_SCRIPT_OUTPUT_PATH,
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
    createdFiles: [],
    envUsed: {},
    id: "prep_001",
    installCommandUsed: "bun install --frozen-lockfile",
    knownLimitations: [],
    localDemoModeChanges: [],
    mocksAndFixturesAdded: [],
    modifiedFiles: [],
    ports: [3000],
    requiredLocalOnlyAssumptions: [],
    scriptGenerationContext: [],
    startCommandUsed: "bun run dev --host 127.0.0.1 --port 3000",
    validationEvidence: ["passed"],
  };
}

function flowSpec() {
  return {
    expectedVisibleAssertions: ["Dashboard heading is visible"],
    id: "flow_001",
    locatorStrategyNotes: ["Use role locators"],
    objective: "Show dashboard",
    referencedActionIds: ["open-dashboard"],
    referencedAppMapRoutePaths: ["/"],
    repairConstraints: ["Preserve the dashboard assertion"],
    requiredAppState: [],
    selectedFlowName: "Dashboard",
    skippedOrBlockedFlows: [],
    steps: ["Open dashboard"],
    userDemoBriefFeaturesCovered: ["dashboard"],
    whySelected: "Visible in app map",
  };
}

function validDemoScript() {
  return {
    demoPlaywrightScript: [
      "import { setup, scene } from './makeademo-capture-sdk';",
      "await setup(async ({ page, baseUrl, expect }) => {",
      "  await page.goto(baseUrl);",
      "  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();",
      "});",
      "await scene('dashboard', async ({ page, expect }) => {",
      "  await page.getByRole('button', { name: 'Open dashboard' }).click();",
      "  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();",
      "});",
    ].join("\n"),
    format: "16:9",
    presentation: {
      music: { enabled: false },
      textOverlays: [],
      transitions: [],
    },
    scenes: [
      {
        expectedVisibleOutcome: "Dashboard heading is visible.",
        humanReadableDescription: "Open the dashboard.",
        id: "dashboard",
      },
    ],
    scriptId: "script_001",
    title: "Dashboard Demo",
    version: 1,
  };
}
