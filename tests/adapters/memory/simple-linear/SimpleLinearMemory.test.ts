import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlConversationStore } from "../../../../src/adapters/file-system/JsonlConversationStore";
import { SimpleLinearMemory } from "../../../../src/adapters/memory/simple-linear/SimpleLinearMemory";
import { ConversationManager } from "../../../../src/core/conversations/ConversationManager";

test("simple linear memory records events and prepares model input", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "simple-linear-memory-"));
  const conversations = new ConversationManager({
    cwd,
    store: new JsonlConversationStore({
      rootDir: join(cwd, ".agent", "conversations"),
    }),
  });
  const conversation = await conversations.createConversation({
    systemPrompt: "Be direct.",
    model: "gpt-5.5",
    reasoning: { effort: "medium", summary: "auto" },
    responseOverrides: {},
  });
  const memory = new SimpleLinearMemory(conversations);

  await memory.record({
    type: "user_message",
    conversationId: conversation.id,
    content: "Use the tool.",
  });
  await memory.record({
    type: "assistant_message",
    conversationId: conversation.id,
    content: [
      { type: "reasoning_summary", text: "Need a tool." },
      { type: "text", text: "Checking..." },
      {
        type: "tool_call",
        toolCall: { callId: "call_1", name: "bash", input: {} },
      },
    ],
  });
  await memory.record({
    type: "tool_result",
    conversationId: conversation.id,
    result: {
      callId: "call_1",
      name: "bash",
      output: "Tool unavailable.",
      isError: true,
    },
  });

  await expect(
    memory.prepareTurn({ conversationId: conversation.id }),
  ).resolves.toMatchObject({
    systemPrompt: "Be direct.",
    settings: { model: "gpt-5.5" },
    messages: [
      { role: "user", content: "Use the tool." },
      {
        role: "assistant",
        content: "Checking...",
      },
      {
        role: "tool_call",
        callId: "call_1",
        name: "bash",
        input: {},
      },
      { role: "tool_result", content: "Tool unavailable.", callId: "call_1" },
    ],
  });
});
