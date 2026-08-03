import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CaptureManifest } from "../06-footage-capture/capture-scenes";
import { createDemoScriptDigest } from "../06-footage-capture/demo-script-identity";
import { parseDemoScript } from "../06-footage-capture/demo-script.schema";
import type { DemoScript } from "../06-footage-capture/demo-script.schema";
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
  it("merges captured and synthetic Scenes in Demo Script order", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const capturedScenePath = join(workspace, "scene-dashboard.webm");
    const staticImagePath = join(workspace, "architecture.png");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    await writeFile(capturedScenePath, "captured dashboard");
    await writeFile(staticImagePath, "static architecture");
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 1,
              sceneId: "dashboard",
              sectionId: "demo-script",
              videoPath: capturedScenePath,
            },
          ],
        }),
      ),
    );

    let renderPlan: CompositingRenderPlan | undefined;
    await compositeVideoFromScript({
      captureManifestPath,
      outputRoot: join(workspace, "renders"),
      renderer: {
        async renderVideo(input) {
          renderPlan = input;
          await writeFile(input.outputPath, "rendered mp4");
        },
      },
      runId: "mixed-scenes",
      scriptPackage: {
        demoPlaywrightScript:
          "await scene('dashboard', async ({ page, expect }) => { await expect(page.locator('main')).toBeVisible(); });",
        format: "16:9",
        presentation: {
          textOverlays: [
            {
              content: "First overlay",
              font: "Inter",
              position: "top-left",
              sceneId: "dashboard",
              size: "small",
            },
            {
              content: "Second overlay",
              font: "Inter",
              position: "bottom-left",
              sceneId: "dashboard",
              size: "medium",
            },
          ],
          transitions: [
            {
              durationSeconds: 0.5,
              fromSceneId: "dashboard",
              style: "fade",
              toSceneId: "title-card",
            },
          ],
        },
        scenes: [
          {
            expectedVisibleOutcome: "The dashboard is visible.",
            id: "dashboard",
            type: "playwright-recording",
          },
          {
            backgroundColor: "#101828",
            durationSeconds: 2,
            id: "title-card",
            text: {
              color: "#ffffff",
              content: "Everything in one place",
              font: "Inter",
              position: "center",
              size: "large",
            },
            type: "full-screen-text",
          },
          {
            alt: "Product architecture diagram",
            assetId: "architecture",
            durationSeconds: 1,
            id: "architecture",
            type: "static-image",
          },
        ],
        scriptId: "script-001",
        title: "Generated Demo",
        version: 1,
      },
      staticImageAssets: {
        architecture: { sourcePath: staticImagePath },
      },
    });

    expect(renderPlan?.durationInFrames).toBe(105);
    expect(renderPlan?.scenes).toEqual([
      expect.objectContaining({
        durationFrames: 30,
        sceneId: "dashboard",
        sourcePublicPath: "scenes/dashboard.webm",
        textOverlays: [
          expect.objectContaining({ content: "First overlay" }),
          expect.objectContaining({ content: "Second overlay" }),
        ],
        type: "playwright-recording",
      }),
      expect.objectContaining({
        backgroundColor: "#101828",
        durationFrames: 60,
        sceneId: "title-card",
        text: expect.objectContaining({ content: "Everything in one place" }),
        textOverlays: [],
        transitionIn: {
          durationFrames: 15,
          fromSceneId: "dashboard",
          style: "fade",
          toSceneId: "title-card",
        },
        type: "full-screen-text",
      }),
      expect.objectContaining({
        alt: "Product architecture diagram",
        durationFrames: 30,
        sceneId: "architecture",
        sourcePublicPath: "scenes/architecture.png",
        textOverlays: [],
        type: "static-image",
      }),
    ]);
    await expect(
      stat(join(renderPlan?.publicDir ?? "", "scenes/architecture.png")),
    ).resolves.toBeTruthy();
  });

  it("rejects a static-image Scene whose asset id names an inherited object property", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const captureManifestPath = join(workspace, "capture-manifest.json");
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [],
        }),
      ),
    );

    await expect(
      compositeVideoFromScript({
        captureManifestPath,
        outputRoot: join(workspace, "renders"),
        renderer: {
          async renderVideo(input) {
            await writeFile(input.outputPath, "rendered mp4");
          },
        },
        runId: "prototype-asset",
        scriptPackage: {
          demoPlaywrightScript:
            "await scene('prototype', async ({ page, expect }) => { await expect(page.locator('main')).toBeVisible(); });",
          format: "16:9",
          presentation: { textOverlays: [], transitions: [] },
          scenes: [
            {
              alt: "Prototype pollution probe",
              assetId: "constructor",
              durationSeconds: 1,
              id: "prototype",
              type: "static-image",
            },
          ],
          scriptId: "script-001",
          title: "Generated Demo",
          version: 1,
        },
        staticImageAssets: {},
      }),
    ).rejects.toThrow(/unknown trusted asset constructor/);
  });

  it("stages Demo Script scenes using captured clip durations and presentation metadata", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const outputRoot = join(workspace, "renders");
    const capturedFeedPath = join(workspace, "scene-feed.webm");
    const capturedEditorPath = join(workspace, "scene-editor.webm");
    const scriptPath = join(workspace, "demo-script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");

    await writeFile(capturedFeedPath, "captured feed");
    await writeFile(capturedEditorPath, "captured editor");
    await writeFile(
      scriptPath,
      JSON.stringify(
        makeDemoScript({ sceneIds: ["scene-feed", "scene-editor"] }),
      ),
    );
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 1.25,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: capturedFeedPath,
            },
            {
              durationSeconds: 2.75,
              sceneId: "scene-editor",
              sectionId: "demo-script",
              videoPath: capturedEditorPath,
            },
          ],
        }),
      ),
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
      durationInFrames: 112,
      fps: 30,
      height: 720,
      outputPath: join(outputRoot, "composite-001", "final-video.mp4"),
      scriptId: "script-001",
      title: "Generated Demo",
      width: 1280,
    });
    expect(renderPlan?.scenes).toMatchObject([
      {
        durationFrames: 38,
        sceneId: "scene-feed",
        sourcePublicPath: "scenes/scene-feed.webm",
        textOverlays: [
          {
            content: "Browse the live feed",
            fontFamily: "Inter",
            position: "top-left",
            size: "medium",
          },
        ],
        type: "playwright-recording",
      },
      {
        durationFrames: 83,
        sceneId: "scene-editor",
        textOverlays: [],
        transitionIn: {
          durationFrames: 9,
          fromSceneId: "scene-feed",
          style: "fade",
          toSceneId: "scene-editor",
        },
        type: "playwright-recording",
      },
    ]);
    expect(renderPlan?.fontAssets).toMatchObject({
      Inter: { publicPath: "fonts/Inter-VariableFont_opsz,wght.ttf" },
    });
    expect(renderPlan?.music).toMatchObject({
      id: "focus",
      publicPath: "music/focus.mp3",
    });
    await expect(
      stat(join(renderPlan?.publicDir ?? "", "scenes/scene-feed.webm")),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(renderPlan?.publicDir ?? "", "scenes/scene-editor.webm")),
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
    expect(JSON.parse(await readFile(manifest.manifestPath, "utf8"))).toEqual(
      manifest,
    );
  });

  it("does not publish a rendered Draft Composite without an explicit accepted review", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const scriptPath = join(workspace, "demo-script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const capturedScenePath = join(workspace, "scene-feed.webm");
    let storageWasCalled = false;
    await writeFile(capturedScenePath, "captured scene");
    await writeFile(scriptPath, JSON.stringify(makeDemoScript()));
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 2,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: capturedScenePath,
            },
          ],
        }),
      ),
    );

    await expect(
      compositeVideoFromScript({
        captureManifestPath,
        demoRequestId: "demo-request-001",
        demoRequestStore: {
          async linkFinalVideo() {
            throw new Error("unreviewed Draft Composite must not be linked");
          },
          async markFinalVideoEmailSent() {},
        },
        finalVideoStorage: {
          async storeFinalVideo() {
            storageWasCalled = true;
            throw new Error("unreviewed Draft Composite must not be stored");
          },
        },
        outputRoot: join(workspace, "renders"),
        renderer: {
          async renderVideo(input) {
            await writeFile(input.outputPath, "rendered mp4");
          },
        },
        runId: "composite-unreviewed",
        scriptPath,
      }),
    ).rejects.toThrow(
      "Draft Composite review is required before final publication",
    );
    expect(storageWasCalled).toBe(false);
  });

  it("persists a typed rejected Draft Composite review without publishing it", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const outputRoot = join(workspace, "renders");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const reviewArtifactPath = join(
      outputRoot,
      "composite-rejected",
      "draft-composite-review.json",
    );
    let storageWasCalled = false;
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [],
        }),
      ),
    );

    await expect(
      compositeVideoFromScript({
        captureManifestPath,
        demoRequestId: "demo-request-001",
        demoRequestStore: {
          async linkFinalVideo() {
            throw new Error("rejected Draft Composite must not be linked");
          },
          async markFinalVideoEmailSent() {},
        },
        draftCompositeReviewer: {
          async reviewDraftComposite() {
            return {
              findings: ["The final card is unreadably brief."],
              status: "rejected",
              warnings: [],
            };
          },
        },
        finalVideoStorage: {
          async storeFinalVideo() {
            storageWasCalled = true;
            throw new Error("rejected Draft Composite must not be stored");
          },
        },
        outputRoot,
        renderer: {
          async renderVideo(input) {
            await writeFile(input.outputPath, "rendered mp4");
          },
        },
        runId: "composite-rejected",
        scriptPackage: {
          format: "16:9",
          presentation: {},
          scenes: [
            {
              backgroundColor: "#101828",
              durationSeconds: 2,
              id: "title-card",
              text: {
                color: "#ffffff",
                content: "Demo complete",
                font: "Inter",
                position: "center",
                size: "large",
              },
              type: "full-screen-text",
            },
          ],
          scriptId: "script-001",
          title: "Generated Demo",
          version: 1,
        },
      }),
    ).rejects.toMatchObject({
      name: "DraftCompositeReviewRejectedError",
      reviewArtifactPath,
    });
    expect(storageWasCalled).toBe(false);
    await expect(
      readFile(reviewArtifactPath, "utf8").then((value) => JSON.parse(value)),
    ).resolves.toMatchObject({
      findings: ["The final card is unreadably brief."],
      status: "rejected",
    });
  });

  it("uploads the final video and links it to the Demo Request without retaining local output", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const outputRoot = join(workspace, "renders");
    const scriptPath = join(workspace, "demo-script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const capturedScenePath = join(workspace, "scene-feed.webm");
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

    await writeFile(capturedScenePath, "captured scene");
    await writeFile(scriptPath, JSON.stringify(makeDemoScript()));
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 2,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: capturedScenePath,
            },
          ],
        }),
      ),
    );

    const storage: FinalVideoStorage = {
      async storeFinalVideo(input) {
        const key = `demo-videos/${input.demoRequestId}/${input.runId}/final-video.mp4`;
        expect(input.body).not.toBeInstanceOf(Uint8Array);
        expect(input.contentLength).toBe(12);
        storedVideos.push({
          body: await readStreamBody(
            input.body as unknown as AsyncIterable<Uint8Array>,
          ),
          demoRequestId: input.demoRequestId,
          key,
          scriptId: input.scriptId,
        });
        return { key, r2Url: `r2://owlet/${key}` };
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
      draftCompositeReviewer: acceptedDraftCompositeReviewer(),
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
    expect(manifest.outputVideoPath).toBeUndefined();
    await expect(
      stat(join(outputRoot, "composite-001", "final-video.mp4")),
    ).rejects.toThrow();
  });

  it("can retain the local Draft Composite after storing final video output", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const outputRoot = join(workspace, "renders");
    const scriptPath = join(workspace, "demo-script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const capturedScenePath = join(workspace, "scene-feed.webm");

    await writeFile(capturedScenePath, "captured scene");
    await writeFile(scriptPath, JSON.stringify(makeDemoScript()));
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 2,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: capturedScenePath,
            },
          ],
        }),
      ),
    );

    const manifest = await compositeVideoFromScript({
      captureManifestPath,
      demoRequestId: "demo-request-001",
      demoRequestStore: {
        async linkFinalVideo() {
          return {
            finalVideoEmailSentAt: null,
            makerEmail: "maker@example.com",
          };
        },
        async markFinalVideoEmailSent() {},
      },
      draftCompositeReviewer: acceptedDraftCompositeReviewer(),
      finalVideoStorage: {
        async storeFinalVideo() {
          return {
            key: "final-video.mp4",
            r2Url: "r2://owlet/final-video.mp4",
          };
        },
      },
      outputRoot,
      renderer: {
        async renderVideo(input) {
          await writeFile(input.outputPath, "rendered mp4");
        },
      },
      retainLocalOutput: true,
      runId: "composite-001",
      scriptPath,
    });

    expect(manifest.outputVideoPath).toBe(
      join(outputRoot, "composite-001", "final-video.mp4"),
    );
    await expect(
      stat(manifest.outputVideoPath as string),
    ).resolves.toBeTruthy();
  });

  it("emails the maker a stable final video link after Compositing completes", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const scriptPath = join(workspace, "demo-script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const capturedScenePath = join(workspace, "scene-feed.webm");
    const sentEmails: Array<{
      demoRequestId: string;
      title: string;
      to: string;
      videoUrl: string;
    }> = [];
    const markedEmails: Array<{ demoRequestId: string; sentAt: string }> = [];

    await writeFile(capturedScenePath, "captured scene");
    await writeFile(scriptPath, JSON.stringify(makeDemoScript()));
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 2,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: capturedScenePath,
            },
          ],
        }),
      ),
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
      draftCompositeReviewer: acceptedDraftCompositeReviewer(),
      finalVideoEmailNotifier: emailNotifier,
      finalVideoStorage: {
        async storeFinalVideo(input) {
          await readStreamBody(input.body);
          return {
            key: "demo-videos/demo-request-001/composite-001/final-video.mp4",
            r2Url:
              "r2://owlet/demo-videos/demo-request-001/composite-001/final-video.mp4",
          };
        },
      },
      outputRoot: join(workspace, "renders"),
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
      { demoRequestId: "demo-request-001", sentAt: expect.any(String) },
    ]);
  });

  it("rejects captured footage when the accepted Demo Script content changed without changing its scriptId", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const capturedScenePath = join(workspace, "scene-feed.webm");
    const acceptedScript = parseDemoScript(makeDemoScript());
    await writeFile(capturedScenePath, "captured scene");
    await writeFile(
      captureManifestPath,
      JSON.stringify({
        ...makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 2,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: capturedScenePath,
            },
          ],
        }),
        scriptDigest: createDemoScriptDigest(acceptedScript),
      }),
    );

    await expect(
      compositeVideoFromScript({
        captureManifestPath,
        outputRoot: join(workspace, "renders"),
        renderer: {
          async renderVideo() {
            throw new Error("renderer must not run for stale captured footage");
          },
        },
        scriptPackage: { ...acceptedScript, title: "Changed after capture" },
      }),
    ).rejects.toThrow("capture manifest Demo Script digest does not match");
  });

  it("rejects a Demo Script when captured footage is missing for a declared Scene", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const scriptPath = join(workspace, "demo-script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    let renderWasCalled = false;

    await writeFile(scriptPath, JSON.stringify(makeDemoScript()));
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [],
        }),
      ),
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
    ).rejects.toThrow(
      "missing captured Scene for Demo Script Scene scene-feed",
    );

    expect(renderWasCalled).toBe(false);
  });

  it("rejects agent-authored recorded Scene durations instead of using them for Compositing", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const scriptPath = join(workspace, "demo-script.json");
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const capturedScenePath = join(workspace, "scene-feed.webm");
    let renderWasCalled = false;

    await writeFile(capturedScenePath, "captured scene");
    await writeFile(
      scriptPath,
      JSON.stringify({
        ...makeDemoScript(),
        scenes: [{ ...makeDemoScript().scenes[0], durationSeconds: 99 }],
      }),
    );
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 1.25,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: capturedScenePath,
            },
          ],
        }),
      ),
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
    ).rejects.toThrow("scenes[0].durationSeconds is not allowed");

    expect(renderWasCalled).toBe(false);
  });

  it("rejects fades that are not shorter than both adjacent Scenes", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const firstScenePath = join(workspace, "scene-feed.webm");
    const secondScenePath = join(workspace, "scene-editor.webm");
    await writeFile(firstScenePath, "first scene");
    await writeFile(secondScenePath, "second scene");
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 1,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: firstScenePath,
            },
            {
              durationSeconds: 1,
              sceneId: "scene-editor",
              sectionId: "demo-script",
              videoPath: secondScenePath,
            },
          ],
        }),
      ),
    );
    const script = makeDemoScript({
      sceneIds: ["scene-feed", "scene-editor"],
    });

    await expect(
      compositeVideoFromScript({
        captureManifestPath,
        outputRoot: join(workspace, "renders"),
        renderer: {
          async renderVideo() {
            throw new Error("renderer must not run");
          },
        },
        scriptPackage: {
          ...script,
          presentation: {
            ...script.presentation,
            transitions: [
              {
                durationSeconds: 1,
                fromSceneId: "scene-feed",
                style: "fade",
                toSceneId: "scene-editor",
              },
            ],
          },
        },
      }),
    ).rejects.toThrow(
      "fade transition scene-feed -> scene-editor must be shorter than both adjacent Scenes",
    );
  });

  it("rejects captured durations that round down to zero frames", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const capturedScenePath = join(workspace, "scene-feed.webm");
    await writeFile(capturedScenePath, "captured scene");
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 0.001,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: capturedScenePath,
            },
          ],
        }),
      ),
    );

    await expect(
      compositeVideoFromScript({
        captureManifestPath,
        outputRoot: join(workspace, "renders"),
        renderer: {
          async renderVideo() {
            throw new Error("renderer must not run");
          },
        },
        scriptPackage: makeDemoScript(),
      }),
    ).rejects.toThrow(
      "duration 0.001 seconds must produce at least one frame at 30 fps",
    );
  });

  it("rejects captured durations that cannot produce a safe integer frame count", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const capturedScenePath = join(workspace, "scene-feed.webm");
    await writeFile(capturedScenePath, "captured scene");
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: Number.MAX_SAFE_INTEGER,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: capturedScenePath,
            },
          ],
        }),
      ),
    );

    await expect(
      compositeVideoFromScript({
        captureManifestPath,
        outputRoot: join(workspace, "renders"),
        renderer: {
          async renderVideo() {
            throw new Error("renderer must not run");
          },
        },
        scriptPackage: makeDemoScript(),
      }),
    ).rejects.toThrow("must produce a safe integer frame count at 30 fps");
  });

  it("rejects final videos that exceed the total duration budget", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const capturedScenePath = join(workspace, "scene-feed.webm");
    await writeFile(capturedScenePath, "captured scene");
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: [
            {
              durationSeconds: 181,
              sceneId: "scene-feed",
              sectionId: "demo-script",
              videoPath: capturedScenePath,
            },
          ],
        }),
      ),
    );

    await expect(
      compositeVideoFromScript({
        captureManifestPath,
        outputRoot: join(workspace, "renders"),
        projectRoot: workspace,
        renderer: {
          async renderVideo() {
            throw new Error("renderer must not run");
          },
        },
        scriptPackage: makeDemoScript(),
      }),
    ).rejects.toThrow("Demo video must be at most 180 seconds (5400 frames)");
  });

  it("rejects chained fades that consume an interior Scene", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "makeademo-composite-test-"),
    );
    const captureManifestPath = join(workspace, "capture-manifest.json");
    const sceneIds = ["scene-first", "scene-middle", "scene-last"];
    const capturedScenes = await Promise.all(
      sceneIds.map(async (sceneId) => {
        const videoPath = join(workspace, `${sceneId}.webm`);
        await writeFile(videoPath, sceneId);
        return {
          durationSeconds: 1,
          sceneId,
          sectionId: "demo-script",
          videoPath,
        };
      }),
    );
    await writeFile(
      captureManifestPath,
      JSON.stringify(
        makeCaptureManifest({
          manifestPath: captureManifestPath,
          runDirectory: workspace,
          scenes: capturedScenes,
        }),
      ),
    );
    const script = makeDemoScript({ sceneIds });

    await expect(
      compositeVideoFromScript({
        captureManifestPath,
        outputRoot: join(workspace, "renders"),
        renderer: {
          async renderVideo() {
            throw new Error("renderer must not run");
          },
        },
        scriptPackage: {
          ...script,
          presentation: {
            ...script.presentation,
            transitions: [
              {
                durationSeconds: 0.6,
                fromSceneId: "scene-first",
                style: "fade",
                toSceneId: "scene-middle",
              },
              {
                durationSeconds: 0.6,
                fromSceneId: "scene-middle",
                style: "fade",
                toSceneId: "scene-last",
              },
            ],
          },
        },
      }),
    ).rejects.toThrow(
      "fade transitions into and out of Scene scene-middle must total less than its duration",
    );
  });
});

function makeDemoScript(input: { sceneIds?: string[] } = {}): DemoScript {
  const sceneIds = input.sceneIds ?? ["scene-feed"];

  return {
    demoPlaywrightScript: sceneIds
      .map((sceneId) => `await scene('${sceneId}', async () => {});`)
      .join("\n"),
    format: "16:9",
    presentation: {
      music: { enabled: true, trackId: "focus" },
      textOverlays: [
        {
          content: "Browse the live feed",
          font: "Inter",
          position: "top-left",
          sceneId: sceneIds[0] ?? "scene-feed",
          size: "medium",
        },
      ],
      transitions:
        sceneIds.length > 1
          ? [
              {
                durationSeconds: 0.3,
                fromSceneId: sceneIds[0] as string,
                style: "fade",
                toSceneId: sceneIds[1] as string,
              },
            ]
          : [],
    },
    scenes: sceneIds.map((sceneId) => ({
      expectedVisibleOutcome: `${sceneId} is visible`,
      humanReadableDescription: `Show ${sceneId}`,
      id: sceneId,
      type: "playwright-recording" as const,
    })),
    scriptId: "script-001",
    title: "Generated Demo",
    version: 1,
  };
}

function makeCaptureManifest(input: {
  manifestPath: string;
  runDirectory: string;
  scenes: CaptureManifest["scenes"];
}): CaptureManifest {
  return {
    baseUrl: "http://localhost:3000",
    createdAt: "2026-06-06T12:00:00.000Z",
    keepTemp: true,
    manifestPath: input.manifestPath,
    qualityFindings: [],
    runDirectory: input.runDirectory,
    runId: "capture-001",
    scenes: input.scenes,
    scriptId: "script-001",
    temporary: true,
    title: "Generated Demo",
  };
}

function acceptedDraftCompositeReviewer() {
  return {
    async reviewDraftComposite() {
      return {
        findings: [],
        status: "accepted" as const,
        warnings: [],
      };
    },
  };
}

async function readStreamBody(body: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
