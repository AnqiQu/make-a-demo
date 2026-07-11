export type CompositingTextStyle = {
  color: string;
  content: string;
  fontFamily: string;
  position: "bottom-left" | "center" | "top-left";
  size: "large" | "medium" | "small";
};

export type CompositingTransition = {
  durationFrames: number;
  fromSceneId: string;
  style: "fade";
  toSceneId: string;
};

type CompositingSceneBase = {
  durationFrames: number;
  sceneId: string;
  textOverlays: CompositingTextStyle[];
  transitionIn?: CompositingTransition;
};

export type CompositingScene =
  | (CompositingSceneBase & {
      sourcePublicPath: string;
      type: "playwright-recording";
    })
  | (CompositingSceneBase & {
      backgroundColor: string;
      text: CompositingTextStyle;
      type: "full-screen-text";
    })
  | (CompositingSceneBase & {
      alt: string;
      sourcePublicPath: string;
      type: "static-image";
    });

export type CompositingFontAsset = {
  family: string;
  publicPath: string;
};

export type CompositingMusicAsset = {
  id: string;
  publicPath: string;
};

export type CompositingRenderPlan = {
  compositionId: "MakeADemoVideo";
  durationInFrames: number;
  fontAssets: Record<string, CompositingFontAsset>;
  fps: number;
  height: number;
  music?: CompositingMusicAsset;
  outputPath: string;
  publicDir: string;
  scenes: CompositingScene[];
  scriptId: string;
  title: string;
  width: number;
};

/**
 * Renders a prepared Compositing plan into one final video file.
 * Implementations must write exactly to outputPath and treat publicDir paths as
 * stable Remotion public assets for the duration of the render.
 */
export interface VideoRenderer {
  renderVideo(input: CompositingRenderPlan): Promise<void>;
}
