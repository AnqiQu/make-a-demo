import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlConversationStore } from "../../../src/adapters/file-system/JsonlConversationStore";
import { ConversationManager } from "../../../src/core/conversations/ConversationManager";
import type { ConversationMessage } from "../../../src/core/conversations/ConversationRecord.interface";

test("conversations keep latest settings and undo removes the latest turn from replay", async () => {
  const conversations = await createConversationManager();
  const conversation = await conversations.createConversation(defaultInput());

  await recordCompletedTurn(conversations, conversation.id, "First");
  await conversations.updateSettings(conversation.id, {
    model: "gpt-5.5",
    reasoning: { effort: "low", summary: "auto" },
    responseOverrides: {},
  });
  await conversations.recordMessage(conversation.id, userText("Second"));

  await conversations.undoLatestTurn(conversation.id);
  const context = await conversations.buildContext(conversation.id);

  expect(context.systemPrompt).toBe("Stay minimal.");
  expect(context.settings).toEqual({
    model: "gpt-5.5",
    reasoning: { effort: "low", summary: "auto" },
    responseOverrides: {},
  });
  expect(context.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);
  expect(context.messages[0]?.content).toEqual([
    { type: "text", text: "First" },
  ]);
});

test("activating a conversation applies current system prompt and settings", async () => {
  const conversations = await createConversationManager();
  const conversation = await conversations.createConversation({
    ...defaultInput(),
    systemPrompt: "Old prompt.",
    responseOverrides: { temperature: 0.1 },
  });
  await recordCompletedTurn(conversations, conversation.id, "Keep this.");

  const activated = await conversations.activateConversation(conversation.id, {
    systemPrompt: "Current prompt.",
    model: "gpt-5.5",
    reasoning: { effort: "low", summary: "auto" },
    responseOverrides: {},
  });
  const context = await conversations.buildContext(conversation.id);

  expect(activated).toEqual(conversation);
  expect(context.systemPrompt).toBe("Current prompt.");
  expect(context.settings).toEqual({
    model: "gpt-5.5",
    reasoning: { effort: "low", summary: "auto" },
    responseOverrides: {},
  });
  expect(roles(context.messages)).toEqual(["user", "assistant"]);
});

test("conversations allow only one open turn", async () => {
  const conversations = await createConversationManager();
  const conversation = await conversations.createConversation(defaultInput());

  await conversations.recordMessage(conversation.id, userText("First"));

  await expect(
    conversations.recordMessage(conversation.id, {
      role: "user",
      content: [{ type: "text", text: "Second" }],
    }),
  ).rejects.toMatchObject({ code: "conversation_invalid" });
});

test("conversations reject agent messages when no turn is open", async () => {
  const conversations = await createConversationManager();
  const conversation = await conversations.createConversation(defaultInput());

  await expect(
    conversations.recordMessage(conversation.id, assistantText("No user yet.")),
  ).rejects.toMatchObject({
    code: "conversation_invalid",
    message: "Cannot append an agent message without an open turn.",
  });
});

test("tool calls keep a turn open until a final assistant message", async () => {
  const conversations = await createConversationManager();
  const conversation = await conversations.createConversation(defaultInput());

  await conversations.recordMessage(conversation.id, userText("Use a tool."));
  await conversations.recordMessage(conversation.id, assistantToolCall());
  await conversations.recordMessage(conversation.id, {
    role: "tool_result",
    content: [{ type: "text", text: "5" }],
    raw: { callId: "call_1", name: "math", output: "5", isError: false },
  });

  await expect(
    conversations.recordMessage(
      conversation.id,
      userText("Next turn too soon."),
    ),
  ).rejects.toMatchObject({ code: "conversation_invalid" });

  await conversations.recordMessage(conversation.id, assistantText("Done."));
  await conversations.recordMessage(conversation.id, userText("Next turn."));
  const context = await conversations.buildContext(conversation.id);

  expect(roles(context.messages)).toEqual([
    "user",
    "assistant",
    "tool_result",
    "assistant",
    "user",
  ]);
});

test("resume creates a conversation when none exist", async () => {
  const conversations = await createConversationManager();

  const created = await conversations.resumeMostRecentOrCreate(defaultInput());

  await expect(conversations.buildContext(created.id)).resolves.toMatchObject({
    systemPrompt: "Stay minimal.",
  });
});

test("resume activates the most recently updated conversation", async () => {
  const conversations = await createConversationManager();
  const older = await conversations.createConversation(defaultInput());
  await nextTimestamp();
  const newer = await conversations.createConversation({
    ...defaultInput(),
    systemPrompt: "Old current prompt.",
  });

  const resumed = await conversations.resumeMostRecentOrCreate({
    ...defaultInput(),
    systemPrompt: "New current prompt.",
    model: "gpt-5.5",
  });
  const context = await conversations.buildContext(resumed.id);

  expect(resumed.id).toBe(newer.id);
  expect(resumed.id).not.toBe(older.id);
  expect(context.systemPrompt).toBe("New current prompt.");
  expect(context.settings.model).toBe("gpt-5.5");
});

test("undoing an empty conversation leaves replay empty", async () => {
  const conversations = await createConversationManager();
  const conversation = await conversations.createConversation(defaultInput());

  await conversations.undoLatestTurn(conversation.id);
  const context = await conversations.buildContext(conversation.id);

  expect(context.messages).toEqual([]);
});

async function createConversationManager(): Promise<ConversationManager> {
  const cwd = await mkdtemp(join(tmpdir(), "agent-conversation-"));
  return new ConversationManager({
    cwd,
    store: new JsonlConversationStore({
      rootDir: join(cwd, ".agent", "conversations"),
    }),
  });
}

function defaultInput() {
  return {
    systemPrompt: "Stay minimal.",
    model: "gpt-5.1",
    reasoning: { effort: "medium", summary: "auto" },
    responseOverrides: {},
  };
}

function userText(text: string): ConversationMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): ConversationMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolCall(): ConversationMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Checking." },
      { type: "tool_call", raw: { callId: "call_1", name: "math", input: {} } },
    ],
  };
}

async function recordCompletedTurn(
  conversations: ConversationManager,
  conversationId: string,
  userMessage: string,
): Promise<void> {
  await conversations.recordMessage(conversationId, userText(userMessage));
  await conversations.recordMessage(conversationId, assistantText("Done"));
}

function roles(messages: readonly ConversationMessage[]): string[] {
  return messages.map((message) => message.role);
}

async function nextTimestamp(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2));
}
