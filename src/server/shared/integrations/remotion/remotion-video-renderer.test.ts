import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompositingRenderPlan } from "../../../pipeline/07-compositing/video-renderer.interface";
import { RemotionVideoRenderer } from "./remotion-video-renderer";

describe("RemotionVideoRenderer", () => {
  it("renders a minimal compositor-native Scene with Remotion's managed headless shell", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "makeademo-remotion-smoke-"),
    );
    const publicDir = join(directory, "public");
    const outputPath = join(directory, "smoke.mp4");
    const bundleDirectory = join(directory, "bundles");
    await mkdir(publicDir, { recursive: true });
    const renderer = new RemotionVideoRenderer({
      // No browserExecutable: use the chrome-headless-shell that Remotion
      // pins and ensures under node_modules/.remotion, exactly like
      // production compositing. Do not pin a full-Chrome build (e.g.
      // Playwright's Chrome for Testing) here: full Chrome stops producing
      // frames while the macOS display sleeps, so the root-component
      // delayRender times out on every unattended run regardless of GL
      // backend or headless mode. The headless shell has no display
      // coupling. First run on a fresh node_modules downloads the shell,
      // the same cost production compositing pays.
      bundleRoot: process.cwd(),
      entryPoint: join(
        process.cwd(),
        "src/server/shared/integrations/remotion/remotion-entry.tsx",
      ),
      tempRoot: bundleDirectory,
      // Remotion's default 30s delayRender timeout has been outrun on a
      // host saturated by parallel suite browsers; keep headroom.
      timeoutInMilliseconds: 120_000,
    });

    try {
      await renderer.renderVideo({
        compositionId: "MakeADemoVideo",
        durationInFrames: 1,
        fontAssets: {},
        fps: 30,
        height: 180,
        outputPath,
        publicDir,
        scenes: [
          {
            backgroundColor: "#101828",
            durationFrames: 1,
            sceneId: "title-card",
            text: {
              color: "#ffffff",
              content: "Make a Demo",
              fontFamily: "Inter",
              position: "center",
              size: "large",
            },
            textOverlays: [],
            type: "full-screen-text",
          },
        ],
        scriptId: "remotion-smoke",
        title: "Remotion Smoke",
        width: 320,
      } satisfies CompositingRenderPlan);

      const output = await stat(outputPath);
      expect(output.isFile()).toBe(true);
      expect(output.size).toBeGreaterThan(0);
      await expect(readdir(bundleDirectory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 300_000);
});
