# Naming Refactor Commit Plan

Start with the model-client rename commit and fold any existing Responses transport file changes into that work.

## 1. Rename Responses Transport To Model Client

Commit message: `rename responses transport to model client`

Scope:

- Replace the deleted `src/core/responses/ResponsesTransport.interface.ts` with a core model-client interface.
- Rename `ResponsesTransport` to `ModelClient`.
- Rename `ResponsesRequest` to `ModelRequest`.
- Rename `ResponsesStreamEvent` to `ModelStreamEvent`.
- Rename `ResponsesMessageInput` to `ModelMessageInput`.
- Rename Agent dependency fields from `transport` / `#transport` to `model` / `#model`.
- Replace the deleted `CodexResponsesTransport` with `CodexModelClient`.
- Update imports, tests, and docs for the new model-client vocabulary.

Checks:

- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `bun run knip`

## 2. Clarify Agent Turn Orchestration Names

Commit message: `clarify agent turn orchestration names`

Scope:

- Rename `RunTurnInput.input` to `userMessage` or `userText`.
- Rename `AssistantPassResult` to `AssistantPassCollector`.
- Rename the `#streamAssistantPass` collector parameter from `result` to `passCollector`.
- Rename assistant response accumulator `content` to `assistantContentBlocks`.
- Rename `#streamAssistantPass` to `#streamAndRecordAssistantPass`.
- Rename tool execution local `result` to `toolResult`.

Checks:

- `bun run lint`
- `bun run typecheck`
- `bun run test`

## 3. Clarify Conversation Manager Names

Commit message: `clarify conversation manager names`

Scope:

- Rename `ConversationManagerOptions` to `ConversationManagerDependencies`.
- Rename constructor `options` to `dependencies`.
- Rename `continueRecentOrCreate` to `resumeMostRecentOrCreate`.
- Rename `appendMessage` to `recordMessage`.
- Rename `latest` to `latestTurn`.
- Rename local `record` variables to `conversationRecord`.
- Rename `completesTurn` to `assistantMessageCompletesTurn`.

Checks:

- `bun run lint`
- `bun run typecheck`
- `bun run test`

## 4. Clarify Codex Response Adapter Names

Commit message: `clarify codex response adapter names`

Scope:

- Rename `mapResponsesEvent` to `mapCodexResponsesEvent`.
- Rename `parseSseMessages` to `parseSseDataMessages`.
- Rename raw provider `event` locals to `rawEvent` or `codexEvent`.
- Rename `item` to `outputItem`.
- Rename `response` to `httpResponse`.
- Rename `detail` to `errorBody`.
- Rename stream-loop `message` to `sseMessage`.
- Rename `mapped` to `modelEvent`.

Checks:

- `bun run lint`
- `bun run typecheck`
- `bun run test`

## 5. Polish CLI And Tool Names

Commit message: `polish cli and tool names`

Scope:

- Rename CLI `args` to `cliArgs`.
- Rename `rl` to `readline`.
- Rename CLI `input` to `userInput`.
- Rename CLI `context` to `preparedTurn`.
- Rename `rendered` to `renderedEventChunk`.
- Rename `OAuthFlowPort` to `CliOAuthFlow`.
- Rename `selectInitialConversation(input)` parameter to `dependencies`.
- In `MathTool`, rename `input` to `rawInput`.
- In `MathTool`, rename `candidate` to `inputObject`.
- In `MathTool`, rename `calculate` to `calculateMathResult`.
- In `MathTool`, rename `toolError` to `toolErrorResult`.
- Update stale CLI help/comments from branch-local settings to current conversation settings.

Checks:

- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `bun run knip`
