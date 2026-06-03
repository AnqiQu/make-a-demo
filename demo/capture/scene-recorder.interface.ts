import type { SceneDescription } from "./video-script-package.schema";

export type RecordSceneInput = {
  baseUrl: string;
  runDirectory: string;
  scene: SceneDescription;
  sectionId: string;
};

export type RecordedScene = {
  durationSeconds: number;
  videoPath: string;
};

/**
 * Records one Scene Description into one temporary raw Scene video.
 * Implementations must fail instead of returning when the browser actions do
 * not complete or no playable video chunk was created.
 */
export type SceneRecorder = {
  recordScene(input: RecordSceneInput): Promise<RecordedScene>;
};
