import { renderConversationHistory } from "../../../src/apps/cli/conversationHistory";

test("renders active conversation history for resumed conversations", async () => {
  const output = await renderConversationHistory(
    {
      buildContext: async () => ({
        conversationId: "conversation_1",
        systemPrompt: "Be useful.",
        settings: { model: "gpt-5.5", responseOverrides: {} },
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "tell me about yourself" }],
          },
          {
            role: "assistant",
            content: [
              { type: "reasoning_summary", text: "Answer directly." },
              { type: "text", text: "I'm an AI assistant." },
            ],
          },
        ],
      }),
    },
    "conversation_1",
  );

  expect(output).toContain("Previous conversation:");
  expect(output).toContain("You:\ntell me about yourself");
  expect(output).toContain("Assistant:\n[reasoning] Answer directly.");
  expect(output).toContain("I'm an AI assistant.");
});

test("renders consecutive history text chunks inline like streaming output", async () => {
  const output = await renderConversationHistory(
    {
      buildContext: async () => ({
        conversationId: "conversation_1",
        systemPrompt: "Be useful.",
        settings: { model: "gpt-5.5", responseOverrides: {} },
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "I" },
              { type: "text", text: "'m" },
              { type: "text", text: " an AI assistant." },
            ],
          },
        ],
      }),
    },
    "conversation_1",
  );

  expect(output).toContain("Assistant:\nI'm an AI assistant.");
  expect(output).not.toContain("I\n'm\n an AI assistant.");
});

test("renders no history block for a new empty conversation", async () => {
  await expect(
    renderConversationHistory(
      {
        buildContext: async () => ({
          conversationId: "conversation_1",
          systemPrompt: "Be useful.",
          settings: { model: "gpt-5.5", responseOverrides: {} },
          messages: [],
        }),
      },
      "conversation_1",
    ),
  ).resolves.toBe("");
});
