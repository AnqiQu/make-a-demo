import type { DemoBrief } from "../01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../01-context-gathering/supporting-documents";
import type { PreparationManifest } from "./preparation-manifest";

export type RepoPreparationInput = {
  normalizedSupportingDocuments: NormalizedSupportingDocument[];
  repoUrl: string;
  structuredDemoIntent: DemoBrief;
  workspaceId: string;
};

type RepoPreparationAgentResult =
  | {
      manifest: unknown;
      status: "succeeded";
    }
  | {
      assumptions: string[];
      blockers: string[];
      status: "failed";
      suggestedChanges: string[];
    };

/**
 * Prepares an ephemeral cloned workspace for deterministic demo validation.
 * Implementations may edit and execute only that workspace, should check for
 * existing demos before creating new setup, and must not modify the source repo.
 */
export interface RepoPreparationAgent {
  prepare(input: RepoPreparationInput): Promise<RepoPreparationAgentResult>;
}

export type RepoPreparationResult =
  | {
      manifest: PreparationManifest;
      status: "succeeded";
    }
  | {
      fallbackPrompt: string;
      status: "failed";
    };
