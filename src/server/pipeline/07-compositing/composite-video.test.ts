import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FinalVideoEmailNotifier } from "../final-output/final-video-email-notifier.interface";
import {
  type CompositedVideoManifest,
  compositeVideoFromScript,
} from "./composite-video";
import type {
  DemoRequestFinalVideoStore,
  FinalVideoStorage,
} from "./final-video-storage.interface";
import type {
  CompositingRenderPlan,
  VideoRenderer,
} from "./video-renderer.interface";

describe("compositeVideoFromScript", () => {
  it("emails the maker a stable final video link after Compositing completes", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const outputRoot = join(workspace, "renders");
    const scriptPath = join(workspace, "script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const sentEmails: Array<{
      demoRequestId: string;
      title: string;
      to: string;
      videoUrl: string;
    }> = [];
    const markedEmails: Array<{
      demoRequestId: string;
      sentAt: string;
    }> = [];

    await writeFile(
      scriptPath,
      JSON.stringify({
        estimatedDurationSeconds: 2,
        format: "16:9",
        scriptId: "script-001",
        sections: [
          {
            id: "section-001",
            scenes: [
              {
                background: { colour: "#101010", type: "solid" },
                description: "Open with text.",
                durationSeconds: 2,
                id: "video-scene-001",
                type: "full-screen-text",
              },
            ],
            title: "Generated Demo",
          },
        ],
        title: "Generated Demo",
        version: 1,
      }),
    );
    await writeFile(
      captureManifestPath,
      JSON.stringify({
        baseUrl: "http://localhost:3000",
        createdAt: "2026-06-06T12:00:00.000Z",
        keepTemp: true,
        manifestPath: captureManifestPath,
        runDirectory: workspace,
        runId: "capture-001",
        scenes: [],
        scriptId: "script-001",
        temporary: true,
        title: "Generated Demo",
      }),
    );

    const emailNotifier: FinalVideoEmailNotifier = {
      async sendFinalVideoReadyEmail(input) {
        sentEmails.push(input);
      },
    };
    const demoRequests: DemoRequestFinalVideoStore = {
      async linkFinalVideo() {
        return {
          finalVideoEmailSentAt: null,
          makerEmail: "maker@example.com",
        };
      },
      async markFinalVideoEmailSent(input) {
        markedEmails.push(input);
      },
    };

    await compositeVideoFromScript({
      captureManifestPath,
      demoRequestId: "demo-request-001",
      demoRequestStore: demoRequests,
      finalVideoEmailNotifier: emailNotifier,
      finalVideoStorage: {
        async storeFinalVideo() {
          return {
            key: "demo-videos/demo-request-001/composite-001/final-video.mp4",
            r2Url:
              "r2://owlet/demo-videos/demo-request-001/composite-001/final-video.mp4",
          };
        },
      },
      outputRoot,
      publicAppBaseUrl: "https://makeademo.example",
      renderer: {
        async renderVideo(input) {
          await writeFile(input.outputPath, "rendered mp4");
        },
      },
      runId: "composite-001",
      scriptPath,
    });

    expect(sentEmails).toEqual([
      {
        demoRequestId: "demo-request-001",
        title: "Generated Demo",
        to: "maker@example.com",
        videoUrl:
          "https://makeademo.example/api/demo-requests/demo-request-001/video",
      },
    ]);
    expect(markedEmails).toEqual([
      {
        demoRequestId: "demo-request-001",
        sentAt: expect.any(String),
      },
    ]);
  });

  it("uploads the final video and links it to the Demo Request without retaining local output", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const outputRoot = join(workspace, "renders");
    const scriptPath = join(workspace, "script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const storedVideos: Array<{
      body: string;
      demoRequestId: string;
      key: string;
      scriptId: string;
    }> = [];
    const linkedVideos: Array<{
      demoRequestId: string;
      generatedDemoUrl: string;
    }> = [];

    await writeFile(
      scriptPath,
      JSON.stringify({
        estimatedDurationSeconds: 2,
        format: "16:9",
        scriptId: "script-001",
        sections: [
          {
            id: "section-001",
            scenes: [
              {
                background: { colour: "#101010", type: "solid" },
                description: "Open with text.",
                durationSeconds: 2,
                id: "video-scene-001",
                type: "full-screen-text",
              },
            ],
            title: "Main flow",
          },
        ],
        title: "Generated Demo",
        version: 1,
      }),
    );
    await writeFile(
      captureManifestPath,
      JSON.stringify({
        baseUrl: "http://localhost:3000",
        createdAt: "2026-06-06T12:00:00.000Z",
        keepTemp: true,
        manifestPath: captureManifestPath,
        runDirectory: workspace,
        runId: "capture-001",
        scenes: [],
        scriptId: "script-001",
        temporary: true,
        title: "Generated Demo",
      }),
    );

    const storage: FinalVideoStorage = {
      async storeFinalVideo(input) {
        const key = `demo-videos/${input.demoRequestId}/${input.runId}/final-video.mp4`;
        storedVideos.push({
          body: new TextDecoder().decode(input.body),
          demoRequestId: input.demoRequestId,
          key,
          scriptId: input.scriptId,
        });
        return {
          key,
          r2Url: `r2://owlet/${key}`,
        };
      },
    };
    const demoRequests: DemoRequestFinalVideoStore = {
      async linkFinalVideo(input) {
        linkedVideos.push(input);
        return {
          finalVideoEmailSentAt: null,
          makerEmail: "maker@example.com",
        };
      },
      async markFinalVideoEmailSent() {
        throw new Error("markFinalVideoEmailSent should not be called");
      },
    };

    const manifest = await compositeVideoFromScript({
      captureManifestPath,
      demoRequestId: "demo-request-001",
      demoRequestStore: demoRequests,
      finalVideoStorage: storage,
      outputRoot,
      renderer: {
        async renderVideo(input) {
          await writeFile(input.outputPath, "rendered mp4");
        },
      },
      runId: "composite-001",
      scriptPath,
    });

    expect(storedVideos).toEqual([
      {
        body: "rendered mp4",
        demoRequestId: "demo-request-001",
        key: "demo-videos/demo-request-001/composite-001/final-video.mp4",
        scriptId: "script-001",
      },
    ]);
    expect(linkedVideos).toEqual([
      {
        demoRequestId: "demo-request-001",
        generatedDemoUrl:
          "r2://owlet/demo-videos/demo-request-001/composite-001/final-video.mp4",
      },
    ]);
    expect(manifest).toMatchObject({
      finalVideo: {
        key: "demo-videos/demo-request-001/composite-001/final-video.mp4",
        r2Url:
          "r2://owlet/demo-videos/demo-request-001/composite-001/final-video.mp4",
      },
      viewUrl:
        "r2://owlet/demo-videos/demo-request-001/composite-001/final-video.mp4",
    } satisfies Partial<CompositedVideoManifest>);
    expect(manifest.outputVideoPath).toBeUndefined();
    await expect(
      stat(join(outputRoot, "composite-001", "final-video.mp4")),
    ).rejects.toThrow();
  });

  it("stages the full script for Remotion and stores a viewable final video manifest", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const outputRoot = join(workspace, "renders");
    const capturedScenePath = join(workspace, "scene-001.webm");
    const staticImagePath = join(workspace, "closing.png");
    const scriptPath = join(workspace, "script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");

    await writeFile(capturedScenePath, "captured scene");
    await writeFile(staticImagePath, "static image");
    await writeFile(
      scriptPath,
      JSON.stringify({
        audio: { enabled: true, music: { id: "focus" } },
        estimatedDurationSeconds: 8,
        format: "16:9",
        scriptId: "script-001",
        sections: [
          {
            id: "section-001",
            scenes: [
              {
                background: { colour: "#101010", type: "solid" },
                description: "Open with text.",
                durationSeconds: 2,
                id: "video-scene-001",
                text: {
                  content: "Launch faster",
                  font: "Inter",
                  "text-colour": "#ffffff",
                  "text-position": "center",
                  "text-size": "large",
                },
                type: "full-screen-text",
              },
              {
                description: "Show the app.",
                durationSeconds: 3,
                id: "video-scene-002",
                playwrightSceneId: "scene-001",
                text: {
                  content: "Record the product",
                  font: "Inter",
                  "text-colour": "#ffffff",
                  "text-position": "top-left",
                  "text-size": "medium",
                },
                type: "playwright-recording",
              },
              {
                description: "Close with a screenshot.",
                durationSeconds: 3,
                id: "video-scene-003",
                image: {
                  alt: "Closing screenshot",
                  assetPath: staticImagePath,
                },
                text: {
                  content: "Ship the demo",
                  font: "Inter",
                  "text-colour": "#ffffff",
                  "text-position": "bottom-left",
                  "text-size": "large",
                },
                type: "static-image",
              },
            ],
            title: "Main flow",
          },
        ],
        title: "Generated Demo",
        version: 1,
      }),
    );
    await writeFile(
      captureManifestPath,
      JSON.stringify({
        baseUrl: "http://localhost:3000",
        createdAt: "2026-06-06T12:00:00.000Z",
        keepTemp: true,
        manifestPath: captureManifestPath,
        runDirectory: workspace,
        runId: "capture-001",
        scenes: [
          {
            durationSeconds: 3,
            sceneId: "scene-001",
            sectionId: "section-001",
            videoPath: capturedScenePath,
          },
        ],
        scriptId: "script-001",
        temporary: true,
        title: "Generated Demo",
      }),
    );

    let renderPlan: CompositingRenderPlan | undefined;
    const renderer: VideoRenderer = {
      async renderVideo(input) {
        renderPlan = input;
        await writeFile(input.outputPath, "rendered mp4");
      },
    };

    const manifest = await compositeVideoFromScript({
      captureManifestPath,
      outputRoot,
      renderer,
      runId: "composite-001",
      scriptPath,
    });

    expect(renderPlan).toMatchObject({
      compositionId: "MakeADemoVideo",
      fps: 30,
      height: 720,
      outputPath: join(outputRoot, "composite-001", "final-video.mp4"),
      scriptId: "script-001",
      title: "Generated Demo",
      width: 1280,
    });
    expect(renderPlan?.durationInFrames).toBe(240);
    expect(renderPlan?.scenes.map((scene) => scene.type)).toEqual([
      "full-screen-text",
      "playwright-recording",
      "static-image",
    ]);
    expect(renderPlan?.scenes[1]).toMatchObject({
      sceneId: "video-scene-002",
      sourcePublicPath: "scenes/scene-001.webm",
    });
    expect(renderPlan?.scenes[2]).toMatchObject({
      sceneId: "video-scene-003",
      sourcePublicPath: "images/video-scene-003.png",
    });
    expect(renderPlan?.fontAssets).toMatchObject({
      Inter: { publicPath: "fonts/Inter-VariableFont_opsz,wght.ttf" },
    });
    expect(renderPlan?.music).toMatchObject({
      id: "focus",
      publicPath: "music/focus.mp3",
    });

    await expect(
      stat(join(renderPlan?.publicDir ?? "", "scenes/scene-001.webm")),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(renderPlan?.publicDir ?? "", "images/video-scene-003.png")),
    ).resolves.toBeTruthy();
    await expect(
      stat(
        join(
          renderPlan?.publicDir ?? "",
          "fonts/Inter-VariableFont_opsz,wght.ttf",
        ),
      ),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(renderPlan?.publicDir ?? "", "music/focus.mp3")),
    ).resolves.toBeTruthy();

    expect(manifest).toMatchObject({
      manifestPath: join(
        outputRoot,
        "composite-001",
        "composite-manifest.json",
      ),
      outputVideoPath: join(outputRoot, "composite-001", "final-video.mp4"),
      runDirectory: join(outputRoot, "composite-001"),
      runId: "composite-001",
      scriptId: "script-001",
      title: "Generated Demo",
      viewUrl: expect.stringContaining("final-video.mp4"),
    } satisfies Partial<CompositedVideoManifest>);

    const manifestJson = JSON.parse(
      await readFile(manifest.manifestPath, "utf8"),
    ) as CompositedVideoManifest;
    expect(manifestJson).toEqual(manifest);
  });

  it("rejects a script when captured footage is missing for a Playwright scene", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const scriptPath = join(workspace, "script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    let renderWasCalled = false;

    await writeFile(
      scriptPath,
      JSON.stringify({
        estimatedDurationSeconds: 3,
        format: "16:9",
        scriptId: "script-001",
        sections: [
          {
            id: "section-001",
            scenes: [
              {
                description: "Show the app.",
                durationSeconds: 3,
                id: "video-scene-001",
                playwrightSceneId: "scene-001",
                type: "playwright-recording",
              },
            ],
            title: "Main flow",
          },
        ],
        title: "Generated Demo",
        version: 1,
      }),
    );
    await writeFile(
      captureManifestPath,
      JSON.stringify({
        baseUrl: "http://localhost:3000",
        createdAt: "2026-06-06T12:00:00.000Z",
        keepTemp: true,
        manifestPath: captureManifestPath,
        runDirectory: workspace,
        runId: "capture-001",
        scenes: [],
        scriptId: "script-001",
        temporary: true,
        title: "Generated Demo",
      }),
    );

    await expect(
      compositeVideoFromScript({
        captureManifestPath,
        outputRoot: join(workspace, "renders"),
        renderer: {
          async renderVideo() {
            renderWasCalled = true;
          },
        },
        scriptPath,
      }),
    ).rejects.toThrow("missing captured Scene for playwrightSceneId scene-001");

    expect(renderWasCalled).toBe(false);
  });
});
