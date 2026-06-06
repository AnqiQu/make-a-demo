import type React from "react";
import { Audio } from "remotion";
import { describe, expect, it } from "vitest";
import type { CompositingRenderPlan } from "../../compositing/video-renderer.interface";
import { MakeADemoVideo } from "./makeademo-video";

describe("MakeADemoVideo", () => {
  it("attaches background music at an audible default volume", () => {
    const element = MakeADemoVideo({
      compositionId: "MakeADemoVideo",
      durationInFrames: 30,
      fontAssets: {},
      fps: 30,
      height: 720,
      music: {
        id: "focus",
        publicPath: "music/focus.mp3",
      },
      outputPath: "final-video.mp4",
      publicDir: "public",
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

    const audioElement = findChildByType(element, Audio);

    expect(audioElement?.props).toMatchObject({
      loop: true,
      src: "/music/focus.mp3",
      volume: 0.75,
    });
  });
});

function findChildByType(
  element: React.ReactNode,
  type: unknown,
): React.ReactElement | undefined {
  if (!isReactElement(element)) {
    return undefined;
  }

  if (element.type === type) {
    return element;
  }

  const children = element.props.children;
  const childList = Array.isArray(children) ? children : [children];

  for (const child of childList) {
    const match = findChildByType(child, type);
    if (match) {
      return match;
    }
  }

  return undefined;
}

function isReactElement(value: React.ReactNode): value is React.ReactElement {
  return typeof value === "object" && value !== null && "type" in value;
}
