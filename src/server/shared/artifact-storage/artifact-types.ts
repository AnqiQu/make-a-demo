type ArtifactKind = "log" | "screenshot" | "demo-script-package";

export type PipelineArtifact = {
  contents: string;
  id: string;
  kind: ArtifactKind;
};

export type PipelineArtifactSummary = Pick<PipelineArtifact, "id" | "kind">;
