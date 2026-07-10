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
                host: "api.example.com",
                phase: "runtime" as const,
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
        { direction: "outbound", host: "api.example.com", phase: "runtime" },
      ],
      failureClassification: "locator failure",
      logsSummary: "locator failed",
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
});
