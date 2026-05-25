# Sync Current Defaults On Conversation Activation

When an existing Conversation becomes active, core applies the current system prompt and Settings. Auto-resume and manual selection use the same activation flow.

The tool catalog stays runtime state, not Conversation state. This favors the user expectation that config and tool changes affect the next session, accepting a small KV cache optimization cost when those inputs change.
