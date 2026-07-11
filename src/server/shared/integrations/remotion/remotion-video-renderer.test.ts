import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompositingRenderPlan } from "../../../pipeline/07-compositing/video-renderer.interface";

const remotion = vi.hoisted(() => ({
  bundle: vi.fn(async () => "serve-url"),
  renderMedia: vi.fn(async () => undefined),
  selectComposition: vi.fn(async () => ({ id: "MakeADemoVideo" })),
}));

vi.mock("@remotion/bundler", () => ({ bundle: remotion.bundle }));
vi.mock("@remotion/renderer", () => ({
  renderMedia: remotion.renderMedia,
  selectComposition: remotion.selectComposition,
}));

import { RemotionVideoRenderer } from "./remotion-video-renderer";

const tempRoots: string[] = [];

afterEach(async () => {
  remotion.bundle.mockClear();
  remotion.renderMedia.mockClear();
  remotion.selectComposition.mockClear();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("RemotionVideoRenderer", () => {
  it("limits each render to two concurrent browser tabs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "makeademo-remotion-"));
    tempRoots.push(tempRoot);
    const renderer = new RemotionVideoRenderer({
      bundleRoot: "/workspace",
      entryPoint: "/workspace/index.ts",
      tempRoot,
    });

    await renderer.renderVideo({
      compositionId: "MakeADemoVideo",
      durationInFrames: 30,
      fontAssets: {},
      fps: 30,
      height: 720,
      outputPath: join(tempRoot, "final-video.mp4"),
      publicDir: "/workspace/public",
      scenes: [
        {
          backgroundColor: "#000000",
          durationFrames: 30,
          sceneId: "scene-001",
          type: "full-screen-text",
        },
      ],
      scriptId: "script-001",
      title: "Demo",
      width: 1280,
    } satisfies CompositingRenderPlan);

    expect(remotion.renderMedia).toHaveBeenCalledWith(
      expect.objectContaining({ concurrency: 2 }),
    );
  });
});
