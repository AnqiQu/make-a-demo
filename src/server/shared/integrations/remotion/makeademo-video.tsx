import type React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import type {
  CompositingRenderPlan,
  CompositingScene,
  CompositingTextStyle,
} from "../../../pipeline/07-compositing/video-renderer.interface";

export const defaultRenderPlan = {
  compositionId: "MakeADemoVideo",
  durationInFrames: 1,
  fontAssets: {},
  fps: 30,
  height: 720,
  outputPath: "final-video.mp4",
  publicDir: "public",
  scenes: [],
  scriptId: "default",
  title: "MakeADemo Video",
  width: 1280,
} satisfies CompositingRenderPlan;

export const MakeADemoVideo: React.FC<CompositingRenderPlan> = (plan) => {
  let cursor = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      <FontFaces plan={plan} />
      {plan.music ? (
        <Audio loop src={staticFile(plan.music.publicPath)} volume={0.75} />
      ) : null}
      {plan.scenes.map((scene) => {
        const overlapFrames = scene.transitionIn?.durationFrames ?? 0;
        const from = cursor - overlapFrames;
        cursor = from + scene.durationFrames;

        return (
          <Sequence
            durationInFrames={scene.durationFrames}
            from={from}
            key={scene.sceneId}
          >
            <SceneFrame scene={scene} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const FontFaces: React.FC<{ plan: CompositingRenderPlan }> = ({ plan }) => {
  const css = Object.values(plan.fontAssets)
    .map(
      (asset) => `@font-face {
  font-family: "${asset.family}";
  src: url("${staticFile(asset.publicPath)}") format("truetype");
  font-display: swap;
}`,
    )
    .join("\n");

  return css.length > 0 ? <style>{css}</style> : null;
};

const SceneFrame: React.FC<{ scene: CompositingScene }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const opacity = scene.transitionIn
    ? calculateTransitionInOpacity(frame, scene.transitionIn.durationFrames)
    : 1;

  return (
    <AbsoluteFill style={{ opacity }}>
      {scene.type === "full-screen-text" ? (
        <AbsoluteFill
          style={{
            backgroundColor: scene.backgroundColor,
          }}
        />
      ) : null}
      {scene.type === "playwright-recording" ? (
        <OffthreadVideo
          muted
          src={staticFile(scene.sourcePublicPath)}
          style={{
            height: "100%",
            objectFit: "cover",
            width: "100%",
          }}
        />
      ) : null}
      {scene.type === "static-image" ? (
        <Img
          alt={scene.alt}
          src={staticFile(scene.sourcePublicPath)}
          style={{
            height: "100%",
            objectFit: "cover",
            width: "100%",
          }}
        />
      ) : null}
      {scene.type === "full-screen-text" ? (
        <TextOverlay text={scene.text} />
      ) : null}
      {scene.textOverlays.map((text, index) => (
        <TextOverlay key={`${scene.sceneId}-overlay-${index}`} text={text} />
      ))}
    </AbsoluteFill>
  );
};

const TextOverlay: React.FC<{ text: CompositingTextStyle }> = ({ text }) => {
  return (
    <AbsoluteFill style={textContainerStyle(text.position)}>
      <div
        style={{
          color: text.color,
          fontFamily: `"${text.fontFamily}", system-ui, sans-serif`,
          fontSize: textSize(text.size),
          fontWeight: 760,
          letterSpacing: 0,
          lineHeight: 1.04,
          maxWidth: text.position === "center" ? 940 : 760,
          textAlign: text.position === "center" ? "center" : "left",
          textShadow: "0 3px 24px rgba(0, 0, 0, 0.55)",
          whiteSpace: "pre-wrap",
        }}
      >
        {text.content}
      </div>
    </AbsoluteFill>
  );
};

function textContainerStyle(position: CompositingTextStyle["position"]) {
  if (position === "center") {
    return {
      alignItems: "center",
      justifyContent: "center",
      padding: 72,
    } satisfies React.CSSProperties;
  }

  if (position === "top-left") {
    return {
      alignItems: "flex-start",
      justifyContent: "flex-start",
      padding: "56px 64px",
    } satisfies React.CSSProperties;
  }

  return {
    alignItems: "flex-start",
    justifyContent: "flex-end",
    padding: "56px 64px",
  } satisfies React.CSSProperties;
}

function textSize(size: CompositingTextStyle["size"]) {
  if (size === "large") {
    return 76;
  }

  if (size === "medium") {
    return 48;
  }

  return 34;
}

function calculateTransitionInOpacity(frame: number, durationFrames: number) {
  return interpolate(frame, [0, durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}
