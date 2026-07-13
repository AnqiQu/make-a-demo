import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CaptureManifest } from "../06-footage-capture/capture-scenes";
import type { DemoScript } from "../06-footage-capture/demo-script.schema";
import type { CompositedVideoManifest } from "./composite-video";
import {
  type DraftCompositeEvidence,
  collectDraftCompositeQualityFindings,
  inspectDraftCompositeEvidence,
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

describe("inspectDraftCompositeEvidence", () => {
  it("probes each captured Scene clip directly for static footage", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-evidence-"));
    const bin = join(root, "bin");
    await writeFile(join(root, "draft.mp4"), "draft");
    await writeFile(join(root, "scene-one.webm"), "scene");
    await writeFile(join(root, "scene-two.webm"), "scene");
    await mkdir(bin, { recursive: true });
    const logPath = join(root, "commands.log");
    const ffmpeg = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nif printf '%s' "$*" | grep -q 'scene-two.webm'; then exit 1; fi\nprintf 'freezedetect freeze_duration: 0.900\\n' >&2\n`;
    const ffprobe = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nprintf '1\\n'\n`;
    await writeFile(join(bin, "ffmpeg"), ffmpeg, { mode: 0o755 });
    await writeFile(join(bin, "ffprobe"), ffprobe, { mode: 0o755 });
    await chmod(join(bin, "ffmpeg"), 0o755);
    await chmod(join(bin, "ffprobe"), 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      const evidence = await inspectDraftCompositeEvidence({
        captureManifest: {
          ...({} as CaptureManifest),
          scenes: [
            {
              durationSeconds: 1.2,
              sceneId: "scene-one",
              sectionId: "demo-script",
              videoPath: join(root, "scene-one.webm"),
            },
            {
              durationSeconds: 1.2,
              sceneId: "scene-two",
              sectionId: "demo-script",
              videoPath: join(root, "scene-two.webm"),
            },
          ],
          qualityFindings: [],
        },
        draftComposite: {
          ...({} as CompositedVideoManifest),
          durationInFrames: 72,
          fps: 30,
          outputVideoPath: join(root, "draft.mp4"),
          runDirectory: root,
        },
      });

      const commands = await readFile(logPath, "utf8");
      const evidenceManifestPath = evidence.evidenceManifestPath;
      expect(evidenceManifestPath).toBeDefined();
      const evidenceManifest = JSON.parse(
        await readFile(evidenceManifestPath ?? "", "utf8"),
      );
      expect(commands).toContain(join(root, "scene-one.webm"));
      expect(commands).toContain(join(root, "scene-two.webm"));
      expect(evidence.staticSceneIds).toEqual(["scene-one"]);
      expect(evidence.staticProbeFailedSceneIds).toEqual(["scene-two"]);
      expect(evidence.evidenceManifestPath).toContain("evidence-manifest.json");
      expect(evidenceManifest).toEqual(
        expect.objectContaining({
          sceneProbes: [
            expect.objectContaining({
              sceneId: "scene-one",
              status: "static",
            }),
            expect.objectContaining({
              sceneId: "scene-two",
              status: "failed",
            }),
          ],
          staticSceneIds: ["scene-one"],
          failedSceneIds: ["scene-two"],
        }),
      );
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
