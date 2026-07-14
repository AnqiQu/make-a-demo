import { describe, expect, it } from "vitest";
import { validateDynamicCapturePath } from "./dynamic-capture-path-validation";

describe("validateDynamicCapturePath", () => {
  it("maps the capture path dry-run result into a durable ValidationReport", async () => {
    const report = await validateDynamicCapturePath(
      {
        preparationManifest: { baseUrl: "http://127.0.0.1:3000" },
        scriptCandidate: {
          outputPath: "/workspace/.makeademo/demo-script.json",
        },
      },
      {
        async runCapturePath() {
          return {
            blockedNetworkAttempts: [
              {
                direction: "outbound" as const,
                hasCredentials: false,
                host: "api.example.com",
                method: "GET",
                phase: "runtime" as const,
                resourceType: "fetch",
                url: "https://api.example.com/data",
              },
            ],
            browserUrl: "http://127.0.0.1:3000",
            logs: ["dry-run failed"],
            status: "failed" as const,
            failureReason: "locator failed",
            warnings: ["retry possible"],
          };
        },
      },
    );

    expect(report).toMatchObject({
      blockedNetworkAttempts: [
        {
          direction: "outbound",
          hasCredentials: false,
          host: "api.example.com",
          method: "GET",
          phase: "runtime",
          resourceType: "fetch",
          url: "https://api.example.com/data",
        },
      ],
      failureClassification: "locator failure",
      logsSummary: "locator failed",
      suggestedRepairHints: [
        "Re-run App Exploration to replace stale locator evidence with a browser-verified candidate.",
      ],
      stage: "capture-path-validation",
      status: "failed",
      urlChecked: "http://127.0.0.1:3000",
    });
  });

  it("classifies an exhausted Daytona artifact transfer separately from script failures", async () => {
    const report = await validateDynamicCapturePath(
      {
        preparationManifest: { baseUrl: "http://127.0.0.1:3000" },
        scriptCandidate: {
          outputPath: "/workspace/.makeademo/demo-script.json",
        },
      },
      {
        async runCapturePath() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "http://127.0.0.1:3000",
            failureReason:
              "AgentHarnessArtifactTransferError: Submitted-code artifact upload failed after 3 attempts in sandbox submitted_123: DaytonaTimeoutError: Operation timed out",
            logs: ["DaytonaTimeoutError: Operation timed out"],
            status: "failed" as const,
            warnings: [],
          };
        },
      },
    );

    expect(report).toMatchObject({
      failureClassification: "transient infrastructure failure",
      status: "failed",
    });
    expect(report.browserObservations).toContain(
      "DaytonaTimeoutError: Operation timed out",
    );
  });

  it("classifies an accepted Demo Script execution timeout as a repairable timing failure", async () => {
    const report = await validateDynamicCapturePath(
      {
        preparationManifest: { baseUrl: "http://127.0.0.1:3000" },
        scriptCandidate: {
          outputPath: "/workspace/.makeademo/demo-script.json",
        },
      },
      {
        async runCapturePath() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "http://127.0.0.1:3000",
            failureReason:
              "Capture Path Validation script timed out after 210s.",
            logs: [],
            status: "failed" as const,
            warnings: [],
          };
        },
      },
    );

    expect(report).toMatchObject({
      failureClassification: "timing/state failure",
      status: "failed",
    });
  });

  it("preserves typed harness classification for Capture SDK instrumentation failures", async () => {
    const report = await validateDynamicCapturePath(
      {
        preparationManifest: { baseUrl: "http://127.0.0.1:3000" },
        scriptCandidate: {
          outputPath: "/workspace/.makeademo/demo-script.json",
        },
      },
      {
        async runCapturePath() {
          return {
            blockedNetworkAttempts: [],
            browserUrl: "http://127.0.0.1:3000",
            failureClassification: "harness/internal failure",
            failureReason:
              "CaptureRuntimeProtocolError: toBeVisible can be only used with Locator object",
            logs: ["Capture SDK assertion instrumentation failed"],
            status: "failed" as const,
            warnings: [],
          };
        },
      },
    );

    expect(report).toMatchObject({
      failureClassification: "harness/internal failure",
      status: "failed",
    });
  });
});
