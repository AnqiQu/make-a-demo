# Prepare Repos in Ephemeral Workspaces

MakeADemo will replace the preparation-first user flow with a pipeline that accepts a repo link and supporting documentation, runs a fast static Repo Security Screen, then lets a preparation agent work inside a locked-down ephemeral cloud workspace to discover existing demos, prepare a deterministic demo runtime, and gather script-generation context. We chose this over requiring the maker to prepare the repo up front because it makes the product flow faster and more automated, while still avoiding write access to the maker's source repo; if preparation fails, MakeADemo returns a targeted Preparation Fallback Prompt instead of generating a script from an unvalidated app.

This supersedes the Stage 1 behavior in ADR 0007 where the maker's own coding agent prepared the repo before submission. Project Validation remains a non-agent gate before downstream output is trusted.
