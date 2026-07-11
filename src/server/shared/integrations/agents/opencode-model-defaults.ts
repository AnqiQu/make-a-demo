/** Default OpenCode model settings used by every MakeADemo Pipeline entrypoint. */
export const defaultOpenCodeModel = {
  modelID: "gpt-5.6-luna",
  providerID: "openai",
  reasoningEffort: "max",
} as const;

/** Model settings reserved for same-session Draft Composite quality review. */
export const draftCompositeReviewOpenCodeModel = {
  modelID: "gpt-5.6-sol",
  providerID: "openai",
  reasoningEffort: "high",
} as const;
