import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type {
  CompositingRenderPlan,
  VideoRenderer,
} from "../../../pipeline/07-compositing/video-renderer.interface";

export type RemotionVideoRendererInput = {
  browserExecutable?: string;
  bundleRoot: string;
  entryPoint: string;
  tempRoot: string;
  timeoutInMilliseconds?: number;
};

export class RemotionVideoRenderer implements VideoRenderer {
  private readonly browserExecutable: string | undefined;
  private readonly bundleRoot: string;
  private readonly entryPoint: string;
  private readonly tempRoot: string;
  private readonly timeoutInMilliseconds: number | undefined;

  constructor(input: RemotionVideoRendererInput) {
    this.browserExecutable = input.browserExecutable;
    this.bundleRoot = input.bundleRoot;
    this.entryPoint = input.entryPoint;
    this.tempRoot = input.tempRoot;
    this.timeoutInMilliseconds = input.timeoutInMilliseconds;
  }

  async renderVideo(input: CompositingRenderPlan): Promise<void> {
    await mkdir(this.tempRoot, { recursive: true });
    const bundleDirectory = join(
      this.tempRoot,
      `${input.scriptId}-${Date.now()}`,
    );

    try {
      const serveUrl = await bundle({
        entryPoint: this.entryPoint,
        outDir: bundleDirectory,
        publicDir: input.publicDir,
        rootDir: this.bundleRoot,
      });
      const composition = await selectComposition({
        ...(this.browserExecutable === undefined
          ? {}
          : { browserExecutable: this.browserExecutable }),
        ...(this.timeoutInMilliseconds === undefined
          ? {}
          : { timeoutInMilliseconds: this.timeoutInMilliseconds }),
        id: input.compositionId,
        inputProps: input,
        logLevel: "warn",
        serveUrl,
      });

      await renderMedia({
        ...(this.browserExecutable === undefined
          ? {}
          : { browserExecutable: this.browserExecutable }),
        ...(this.timeoutInMilliseconds === undefined
          ? {}
          : { timeoutInMilliseconds: this.timeoutInMilliseconds }),
        codec: "h264",
        composition,
        inputProps: input,
        logLevel: "info",
        outputLocation: input.outputPath,
        overwrite: true,
        serveUrl,
      });
    } finally {
      await rm(bundleDirectory, { force: true, recursive: true });
    }
  }
}
