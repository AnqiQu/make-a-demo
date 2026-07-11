import type { BrowserAction } from "./browser-action-plan";
import type { PlaywrightRecordingSceneDescription } from "./demo-script.schema";

export type RecordSceneInput = {
  baseUrl: string;
  demoPlaywrightScript: string;
  retainRawTake?: boolean;
  runDirectory: string;
  scenes: PlaywrightRecordingSceneDescription[];
  sectionId: string;
  setupActions?: BrowserAction[];
};

export type RecordedScene = {
  durationSeconds: number;
  markerEndMs: number;
  markerStartMs: number;
  videoPath: string;
  sceneId: string;
  sectionId: string;
};

/**
 * Records one continuous Demo Script take and returns one clip per declared Scene.
 * Implementations must keep setup outside Scene marker ranges, preserve browser
 * state across Scenes, and fail instead of returning when marker coverage or
 * video output is incomplete.
 */
export type SceneRecorder = {
  recordScenes(input: RecordSceneInput): Promise<RecordedScene[]>;
};
