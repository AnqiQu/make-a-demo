import type React from "react";
import {
  type CalculateMetadataFunction,
  Composition,
  registerRoot,
} from "remotion";
import type { CompositingRenderPlan } from "../../../pipeline/05-compositing/video-renderer.interface";
import { MakeADemoVideo, defaultRenderPlan } from "./makeademo-video";

const calculateMetadata: CalculateMetadataFunction<CompositingRenderPlan> = ({
  props,
}) => {
  return {
    durationInFrames: Math.max(1, props.durationInFrames),
    fps: props.fps,
    height: props.height,
    props,
    width: props.width,
  };
};

const RemotionRoot: React.FC = () => {
  return (
    <Composition
      calculateMetadata={calculateMetadata}
      component={MakeADemoVideo}
      defaultProps={defaultRenderPlan}
      durationInFrames={defaultRenderPlan.durationInFrames}
      fps={defaultRenderPlan.fps}
      height={defaultRenderPlan.height}
      id={defaultRenderPlan.compositionId}
      width={defaultRenderPlan.width}
    />
  );
};

registerRoot(RemotionRoot);
