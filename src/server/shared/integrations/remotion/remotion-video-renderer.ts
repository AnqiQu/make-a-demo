import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type {
  CompositingRenderPlan,
  VideoRenderer,
} from "../../../pipeline/05-compositing/video-renderer.interface";

export type RemotionVideoRendererInput = {
  bundleRoot: string;
  entryPoint: string;
  tempRoot: string;
};

export class RemotionVideoRenderer implements VideoRenderer {
  private readonly bundleRoot: string;
  private readonly entryPoint: string;
  private readonly tempRoot: string;

  constructor(input: RemotionVideoRendererInput) {
    this.bundleRoot = input.bundleRoot;
    this.entryPoint = input.entryPoint;
    this.tempRoot = input.tempRoot;
  }

  async renderVideo(input: CompositingRenderPlan): Promise<void> {
    await mkdir(this.tempRoot, { recursive: true });

    const serveUrl = await bundle({
      entryPoint: this.entryPoint,
      outDir: join(this.tempRoot, `${input.scriptId}-${Date.now()}`),
      publicDir: input.publicDir,
      rootDir: this.bundleRoot,
    });
    const composition = await selectComposition({
      id: input.compositionId,
      inputProps: input,
      logLevel: "warn",
      serveUrl,
    });

    await renderMedia({
      codec: "h264",
      composition,
      inputProps: input,
      logLevel: "info",
      outputLocation: input.outputPath,
      overwrite: true,
      serveUrl,
    });
  }
}
