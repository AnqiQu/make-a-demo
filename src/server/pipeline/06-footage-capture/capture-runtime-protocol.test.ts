import { describe, expect, it } from "vitest";
import {
  CaptureBrowserActionFailureError,
  readCaptureRuntimeProtocol,
  readSuccessfulCaptureProtocol,
  readSuccessfulCaptureSceneRanges,
} from "./capture-runtime-protocol";

describe("Capture Runtime Protocol", () => {
  it("combines both process streams into authoritative Scene and assertion evidence", () => {
    const protocol = readCaptureRuntimeProtocol({
      stderr: [
        actionMarker(
          12,
          "succeeded",
          "scene-one",
          "expect.toBeVisible(locator(main))",
        ),
        sceneMarker(20, "succeeded", "scene-one"),
        '[makeademo:network-blocked] {"direction":"outbound","host":"analytics.example.com","phase":"runtime","resourceType":"fetch","url":"https://analytics.example.com/track"}',
        '[makeademo:validation] script succeeded {"title":"Demo"}',
      ].join("\n"),
      stdout: [
        '[makeademo:validation] script started {"baseUrl":"http://127.0.0.1:3000"}',
        sceneMarker(10, "started", "scene-one"),
        actionMarker(
          11,
          "started",
          "scene-one",
          "expect.toBeVisible(locator(main))",
        ),
      ].join("\n"),
    });

    expect(protocol.blockedNetworkAttempts).toEqual([
      {
        direction: "outbound",
        host: "analytics.example.com",
        phase: "runtime",
        resourceType: "fetch",
        url: "https://analytics.example.com/track",
      },
    ]);
    expect(
      readSuccessfulCaptureSceneRanges({
        protocol,
        sceneIds: ["scene-one"],
      }).get("scene-one"),
    ).toEqual({ endedAtMs: 20, startedAtMs: 10 });
  });

  it("rejects browser Scenes executed in a different order than declared", () => {
    const protocol = readCaptureRuntimeProtocol({
      stderr: "",
      stdout: [
        '[makeademo:validation] script started {"baseUrl":"http://127.0.0.1:3000"}',
        sceneMarker(10, "started", "scene-two"),
        sceneMarker(20, "succeeded", "scene-two"),
        sceneMarker(30, "started", "scene-one"),
        sceneMarker(40, "succeeded", "scene-one"),
        '[makeademo:validation] script succeeded {"title":"Demo"}',
      ].join("\n"),
    });

    expect(() =>
      readSuccessfulCaptureSceneRanges({
        protocol,
        requireVisibleAssertions: false,
        sceneIds: ["scene-one", "scene-two"],
      }),
    ).toThrow("Scene scene-two out of order; expected scene-one");
  });

  it("validates compiled step lifecycles and exposes executed action IDs per Scene", () => {
    const protocol = readCaptureRuntimeProtocol({
      stderr: [
        stepMarker(13, "succeeded", "scene-one", "show-heading"),
        sceneMarker(20, "succeeded", "scene-one"),
        '[makeademo:validation] script succeeded {"title":"Demo"}',
      ].join("\n"),
      stdout: [
        '[makeademo:validation] script started {"baseUrl":"http://127.0.0.1:3000"}',
        sceneMarker(10, "started", "scene-one"),
        stepMarker(11, "started", "scene-one", "show-heading"),
        actionMarker(
          11.5,
          "started",
          "scene-one",
          "expect.toBeVisible(locator(main))",
        ),
        actionMarker(
          12,
          "succeeded",
          "scene-one",
          "expect.toBeVisible(locator(main))",
        ),
      ].join("\n"),
    });

    const result = readSuccessfulCaptureProtocol({
      protocol,
      sceneIds: ["scene-one"],
    });

    expect(result.executedStepIdsByScene.get("scene-one")).toEqual([
      "show-heading",
    ]);
  });

  it("rejects nested compiled steps", () => {
    const protocol = readCaptureRuntimeProtocol({
      stderr: "",
      stdout: [
        '[makeademo:validation] script started {"baseUrl":"http://127.0.0.1:3000"}',
        sceneMarker(10, "started", "scene-one"),
        stepMarker(11, "started", "scene-one", "outer"),
        stepMarker(12, "started", "scene-one", "inner"),
        stepMarker(13, "succeeded", "scene-one", "inner"),
        stepMarker(14, "succeeded", "scene-one", "outer"),
        sceneMarker(20, "succeeded", "scene-one"),
        '[makeademo:validation] script succeeded {"title":"Demo"}',
      ].join("\n"),
    });

    expect(() =>
      readSuccessfulCaptureProtocol({
        protocol,
        requireVisibleAssertions: false,
        sceneIds: ["scene-one"],
      }),
    ).toThrow("nested step markers");
  });

  it("requires the compiled action IDs declared for each browser Scene", () => {
    const protocol = readCaptureRuntimeProtocol({
      stderr: "",
      stdout: [
        '[makeademo:validation] script started {"baseUrl":"http://127.0.0.1:3000"}',
        sceneMarker(10, "started", "scene-one"),
        stepMarker(11, "started", "scene-one", "unexpected-action"),
        stepMarker(12, "succeeded", "scene-one", "unexpected-action"),
        actionMarker(
          13,
          "started",
          "scene-one",
          "expect.toBeVisible(locator(main))",
        ),
        actionMarker(
          14,
          "succeeded",
          "scene-one",
          "expect.toBeVisible(locator(main))",
        ),
        sceneMarker(20, "succeeded", "scene-one"),
        '[makeademo:validation] script succeeded {"title":"Demo"}',
      ].join("\n"),
    });

    expect(() =>
      readSuccessfulCaptureProtocol({
        expectedStepIdsByScene: { "scene-one": ["expected-action"] },
        protocol,
        sceneIds: ["scene-one"],
      }),
    ).toThrow(
      "Scene scene-one executed compiled steps unexpected-action; expected expected-action",
    );
  });

  it("requires the compiled action IDs declared for off-camera setup", () => {
    const protocol = readCaptureRuntimeProtocol({
      stderr: "",
      stdout: [
        '[makeademo:validation] script started {"baseUrl":"http://127.0.0.1:3000"}',
        stepMarker(1, "started", "setup", "unexpected-setup"),
        stepMarker(2, "succeeded", "setup", "unexpected-setup"),
        sceneMarker(10, "started", "scene-one"),
        actionMarker(
          11,
          "started",
          "scene-one",
          "expect.toBeVisible(locator(main))",
        ),
        actionMarker(
          12,
          "succeeded",
          "scene-one",
          "expect.toBeVisible(locator(main))",
        ),
        sceneMarker(20, "succeeded", "scene-one"),
        '[makeademo:validation] script succeeded {"title":"Demo"}',
      ].join("\n"),
    });

    expect(() =>
      readSuccessfulCaptureProtocol({
        expectedStepIdsByScene: { setup: ["expected-setup"] },
        protocol,
        sceneIds: ["scene-one"],
      }),
    ).toThrow(
      "Setup executed compiled steps unexpected-setup; expected expected-setup",
    );
  });

  it("reports a failed compiled action before the generic validation failure", () => {
    const protocol = readCaptureRuntimeProtocol({
      stderr: "",
      stdout: [
        '[makeademo:validation] script started {"baseUrl":"http://127.0.0.1:3000"}',
        sceneMarker(10, "started", "scene-one"),
        stepMarker(11, "started", "scene-one", "open-dashboard"),
        `[makeademo:step] ${JSON.stringify({ elapsedMs: 12, event: "failed", message: "button timed out", sceneId: "scene-one", stepId: "open-dashboard" })}`,
        '[makeademo:validation] script failed {"message":"Operation timed out"}',
      ].join("\n"),
    });

    const readFailure = () =>
      readSuccessfulCaptureProtocol({
        protocol,
        sceneIds: ["scene-one"],
      });
    expect(readFailure).toThrowError(CaptureBrowserActionFailureError);
    expect(readFailure).toThrow(
      "Browser action open-dashboard failed in Scene scene-one. button timed out",
    );
  });
});

function actionMarker(
  elapsedMs: number,
  event: "failed" | "started" | "succeeded",
  sceneId: string,
  label: string,
) {
  return `[makeademo:action] ${JSON.stringify({ elapsedMs, event, label, sceneId })}`;
}

function sceneMarker(
  elapsedMs: number,
  event: "failed" | "started" | "succeeded",
  sceneId: string,
) {
  return `[makeademo:scene] ${JSON.stringify({ elapsedMs, event, sceneId })}`;
}

function stepMarker(
  elapsedMs: number,
  event: "failed" | "started" | "succeeded",
  sceneId: string,
  stepId: string,
) {
  return `[makeademo:step] ${JSON.stringify({ elapsedMs, event, sceneId, stepId })}`;
}
