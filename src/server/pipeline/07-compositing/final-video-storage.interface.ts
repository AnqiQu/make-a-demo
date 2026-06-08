export type FinalVideoUploadInput = {
  body: Uint8Array;
  contentType: "video/mp4";
  demoRequestId: string;
  fileName: "final-video.mp4";
  runId: string;
  scriptId: string;
};

export type StoredFinalVideo = {
  key: string;
  r2Url: string;
};

/**
 * Stores the final Compositing video in durable video storage.
 * Implementations must store the bytes under a Demo Request-scoped key and
 * return the canonical private URL that downstream persistence should record.
 */
export interface FinalVideoStorage {
  storeFinalVideo(input: FinalVideoUploadInput): Promise<StoredFinalVideo>;
}

export type LinkFinalVideoInput = {
  demoRequestId: string;
  generatedDemoUrl: string;
};

/**
 * Links a generated final video to its Demo Request in durable persistence.
 * Implementations must update only the identified Demo Request and must not
 * create a new request when the id is missing.
 */
export interface DemoRequestFinalVideoStore {
  linkFinalVideo(input: LinkFinalVideoInput): Promise<void>;
}
