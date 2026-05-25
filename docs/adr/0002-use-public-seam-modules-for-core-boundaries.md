# Use Public Seam Modules For Core Boundaries

Core boundaries are exposed through explicit public seam modules: `*.interface.ts` for type-only seams, `*.schema.ts` for runtime validation, and explicit runtime modules such as `AgentError.ts` for values that callers construct or catch. Adapters may depend on these public core seams, but not on core implementation modules, so replaceable storage, auth, model, memory, and tool implementations can change without reaching through core internals.
