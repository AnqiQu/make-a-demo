import type {
  PipelineArtifact,
  PipelineArtifactSummary,
} from "./artifact-types";

/**
 * Stores artifacts copied out of sandboxed or generated pipeline work.
 * Implementations must preserve artifact contents by id and expose summaries
 * without requiring callers to know the storage provider.
 */
export interface ArtifactStore {
  listArtifacts(): Promise<PipelineArtifactSummary[]>;
  readArtifact(id: string): Promise<PipelineArtifact | undefined>;
  writeArtifact(artifact: PipelineArtifact): Promise<void>;
}
