type ArtifactKind = "log" | "screenshot" | "video-script-package";

export type PipelineArtifact = {
  contents: string;
  id: string;
  kind: ArtifactKind;
};

export type PipelineArtifactSummary = Pick<PipelineArtifact, "id" | "kind">;
