import { CodexModelClient } from "../../../../src/adapters/codex/responses/CodexModelClient";

function sseStream(events: readonly unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.close();
    },
  });
}

test("Codex model client streams text, reasoning summaries, tool calls, and completion", async () => {
  const requests: Array<{
    readonly url: string;
    readonly body: unknown;
    readonly authorization: string | null;
  }> = [];
  const model = new CodexModelClient({
    getAccessToken: async () => "access-token",
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(
        sseStream([
          {
            type: "response.reasoning_summary_text.delta",
            delta: "I will inspect.",
          },
          { type: "response.output_text.delta", delta: "Hello" },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call_1",
              name: "bash",
              arguments: "{}",
            },
          },
          { type: "response.completed", response: { id: "resp_1" } },
        ]),
        { status: 200 },
      );
    },
  });

  const events = [];
  for await (const event of model.stream({
    prefix: { systemPrompt: "Be useful.", tools: [] },
    settings: {
      model: "gpt-5.1",
      reasoning: { effort: "medium", summary: "auto" },
      responseOverrides: { parallel_tool_calls: false },
    },
    messages: [{ role: "user", content: "Hi" }],
  })) {
    events.push(event);
  }

  expect(requests[0]).toMatchObject({
    url: "https://chatgpt.com/backend-api/codex/responses",
    authorization: "Bearer access-token",
  });
  expect(requests[0]?.body).toMatchObject({
    model: "gpt-5.1",
    instructions: "Be useful.",
    reasoning: { effort: "medium", summary: "auto" },
    parallel_tool_calls: false,
    store: false,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Hi" }],
      },
    ],
  });
  expect(events).toEqual([
    {
      type: "reasoning_summary.delta",
      delta: "I will inspect.",
      raw: expect.any(Object),
    },
    { type: "text.delta", delta: "Hello", raw: expect.any(Object) },
    {
      type: "tool_call",
      callId: "call_1",
      name: "bash",
      input: {},
      raw: expect.any(Object),
    },
    { type: "completed", raw: expect.any(Object) },
  ]);
});

test("Codex model client includes response error details when the backend rejects a request", async () => {
  const model = new CodexModelClient({
    getAccessToken: async () => "access-token",
    fetch: async () => new Response("bad request detail", { status: 400 }),
  });

  await expect(async () => {
    for await (const _event of model.stream({
      prefix: { systemPrompt: "Be useful.", tools: [] },
      settings: {
        model: "gpt-5.5",
        reasoning: { effort: "medium", summary: "auto" },
        responseOverrides: {},
      },
      messages: [{ role: "user", content: "Hi" }],
    })) {
      // consume stream
    }
  }).rejects.toThrow("bad request detail");
});

test("Codex model client replays tool calls before their outputs", async () => {
  const requests: Array<{ readonly body: Record<string, unknown> }> = [];
  const model = new CodexModelClient({
    getAccessToken: async () => "access-token",
    fetch: async (_input, init) => {
      requests.push({ body: JSON.parse(String(init?.body)) });
      return new Response(
        sseStream([{ type: "response.completed", response: { id: "resp_1" } }]),
        { status: 200 },
      );
    },
  });

  for await (const _event of model.stream({
    prefix: { systemPrompt: "Be useful.", tools: [] },
    settings: {
      model: "gpt-5.5",
      reasoning: { effort: "medium", summary: "auto" },
      responseOverrides: {},
    },
    messages: [
      { role: "user", content: "Calculate three sums." },
      { role: "assistant", content: "I will calculate them." },
      {
        role: "tool_call",
        callId: "call_1",
        name: "math",
        input: { operation: "add", left: 1, right: 2 },
      },
      {
        role: "tool_call",
        callId: "call_2",
        name: "math",
        input: { operation: "add", left: 15, right: 20 },
      },
      { role: "tool_result", callId: "call_1", content: "3" },
      { role: "tool_result", callId: "call_2", content: "35" },
    ],
  })) {
    // consume stream
  }

  expect(requests[0]?.body.input).toEqual([
    {
      role: "user",
      content: [{ type: "input_text", text: "Calculate three sums." }],
    },
    {
      role: "assistant",
      content: [{ type: "output_text", text: "I will calculate them." }],
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "math",
      arguments: JSON.stringify({ operation: "add", left: 1, right: 2 }),
    },
    {
      type: "function_call",
      call_id: "call_2",
      name: "math",
      arguments: JSON.stringify({ operation: "add", left: 15, right: 20 }),
    },
    { type: "function_call_output", call_id: "call_1", output: "3" },
    { type: "function_call_output", call_id: "call_2", output: "35" },
  ]);
});
