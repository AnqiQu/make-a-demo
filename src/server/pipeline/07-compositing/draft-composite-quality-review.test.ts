import { describe, expect, it } from "vitest";

import type { CaptureManifest } from "../06-footage-capture/capture-scenes";
import type { DemoScript } from "../06-footage-capture/demo-script.schema";
import type { CompositedVideoManifest } from "./composite-video";
import {
  type DraftCompositeEvidence,
  collectDraftCompositeQualityFindings,
} from "./draft-composite-quality-review";

describe("collectDraftCompositeQualityFindings", () => {
  it("reports deterministic Draft Composite quality gates without needing a reviewer", () => {
    const findings = collectDraftCompositeQualityFindings({
      captureManifest: {
        ...({} as CaptureManifest),
        qualityFindings: ["capture reported a clipped scene"],
        scenes: [
          {
            durationSeconds: 31,
            sceneId: "scene-feed",
            sectionId: "demo-script",
            videoPath: "/tmp/scene-feed.webm",
          },
        ],
      },
      draftEvidence: {
        audioPresent: false,
        contactSheetPaths: [],
        ffmpegFindings: [],
        sampledFramePaths: [],
        staticSceneIds: ["scene-feed"],
      } satisfies DraftCompositeEvidence,
      finalVideo: {
        ...({} as CompositedVideoManifest),
        durationInFrames: 121 * 30,
        fps: 30,
      },
      scriptPackage: {
        ...({} as DemoScript),
        presentation: {
          ...({} as DemoScript["presentation"]),
          music: { enabled: true, trackId: "focus" },
        },
      },
    });

    expect(findings).toEqual([
      "capture reported a clipped scene",
      "Draft Composite duration 121.00s exceeds 120s",
      "Scene scene-feed duration 31.00s exceeds 30s",
      "Draft Composite is missing audio while music is enabled",
      "Scene scene-feed contains fully static footage",
    ]);
  });
});
