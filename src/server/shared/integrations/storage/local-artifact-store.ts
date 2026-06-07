import type { ArtifactStore } from "../../artifact-storage/artifact-store.interface";
import type {
  PipelineArtifact,
  PipelineArtifactSummary,
} from "../../artifact-storage/artifact-types";

export class LocalArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, PipelineArtifact>();

  async listArtifacts(): Promise<PipelineArtifactSummary[]> {
    return Array.from(this.artifacts.values()).map(({ id, kind }) => ({
      id,
      kind,
    }));
  }

  async readArtifact(id: string): Promise<PipelineArtifact | undefined> {
    return this.artifacts.get(id);
  }

  async writeArtifact(artifact: PipelineArtifact): Promise<void> {
    this.artifacts.set(artifact.id, artifact);
  }
}
