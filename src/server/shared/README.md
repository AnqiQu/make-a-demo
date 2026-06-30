# Shared Modules

This directory is for infrastructure shared by product modules, not for defining the MakeADemo Pipeline itself.

- `integrations/` contains concrete adapters for external seams such as Daytona, OpenCode, browser automation, storage, email, and rendering.
- `persistence/` contains database adapters and schema definitions.
- Shared adapters may implement pipeline interfaces, but should avoid owning stage policy or orchestration control flow.
- Pipeline coordination belongs under `src/server/pipeline/00-orchestration/`.
