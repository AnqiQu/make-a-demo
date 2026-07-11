import type { Readable } from "node:stream";

export type FinalVideoUploadInput = {
  body: Readable;
  contentLength: number;
  contentType: "video/mp4";
  demoRequestId: string;
  fileName: "final-video.mp4";
  runId: string;
  scriptDigest: string;
  scriptId: string;
};

export type StoredFinalVideo = {
  key: string;
  r2Url: string;
};

/**
 * Stores the final Compositing video in durable video storage.
 * Implementations must consume the body as a stream, use the Demo Request and
 * Script digest as an idempotent object identity, and return the canonical
 * private URL that downstream persistence should record. Retrying the same
 * accepted Script must replace or reuse the same object rather than orphaning
 * another upload.
 */
export interface FinalVideoStorage {
  storeFinalVideo(input: FinalVideoUploadInput): Promise<StoredFinalVideo>;
}

export type LinkFinalVideoInput = {
  demoRequestId: string;
  generatedDemoUrl: string;
};

export type LinkedFinalVideoDemoRequest = {
  finalVideoEmailSentAt: string | null;
  makerEmail: string;
};

export type MarkFinalVideoEmailSentInput = {
  demoRequestId: string;
  sentAt: string;
};

/**
 * Links a generated final video to its Demo Request in durable persistence.
 * Implementations must update only the identified Demo Request, return the
 * maker email for final-output notification, and must not create a new request
 * when the id is missing.
 */
export interface DemoRequestFinalVideoStore {
  linkFinalVideo(
    input: LinkFinalVideoInput,
  ): Promise<LinkedFinalVideoDemoRequest>;
  markFinalVideoEmailSent(input: MarkFinalVideoEmailSentInput): Promise<void>;
}
