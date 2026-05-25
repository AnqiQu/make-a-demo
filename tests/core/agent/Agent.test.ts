import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlConversationStore } from "../../../src/adapters/file-system/JsonlConversationStore";
import { SimpleLinearMemory } from "../../../src/adapters/memory/simple-linear/SimpleLinearMemory";
import { Agent } from "../../../src/core/agent/Agent";
import type { AgentTurnEvent } from "../../../src/core/agent/events";
import { ConversationManager } from "../../../src/core/conversations/ConversationManager";
import type {
  ModelRequest,
  ModelStreamEvent,
} from "../../../src/core/model/ModelClient.interface";
import type {
  Tool,
  ToolCallRequest,
  ToolCallResult,
} from "../../../src/core/tools/Tool.interface";
import { ToolRegistry } from "../../../src/core/tools/ToolRegistry";

test("agent runs a tool recovery pass when the model requests tools", async () => {
  const model = modelWithPasses([
    [
      { type: "reasoning_summary.delta", delta: "Need a tool.", raw: {} },
      { type: "text.delta", delta: "Checking...", raw: {} },
      toolCall("call_1", "bash", {}),
      toolCall("call_2", "math", { operation: "add", left: 2, right: 3 }),
      { type: "completed", raw: {} },
    ],
    [
      {
        type: "text.delta",
        delta: "No tool is available, so I will answer directly.",
        raw: {},
      },
      { type: "completed", raw: {} },
    ],
  ]);
  const { agent, conversation } = await createHarness({ model });

  const events = await collectTurn(
    agent.runTurn({
      conversationId: conversation.id,
      userMessage: "Please inspect.",
    }),
  );
  expect(eventTypes(events)).toEqual([
    "reasoning_summary.delta",
    "text.delta",
    "tool_call",
    "tool_call",
    "tool_result",
    "tool_result",
    "text.delta",
    "completed",
  ]);
  expect(model.requests).toHaveLength(2);
});

test("agent sends stable prefix and replay messages to the recovery pass", async () => {
  const model = modelWithPasses([
    [
      { type: "text.delta", delta: "Checking...", raw: {} },
      toolCall("call_1", "bash", {}),
      { type: "completed", raw: {} },
    ],
    [{ type: "completed", raw: {} }],
  ]);
  const { agent, conversation } = await createHarness({ model });

  await collectTurn(
    agent.runTurn({ conversationId: conversation.id, userMessage: "Inspect." }),
  );

  expect(model.requests[0]?.prefix).toEqual({
    systemPrompt: "Be direct.",
    tools: [],
  });
  expect(model.requests[1]?.messages).toEqual([
    { role: "user", content: "Inspect." },
    { role: "assistant", content: "Checking..." },
    { role: "tool_call", callId: "call_1", name: "bash", input: {} },
    {
      role: "tool_result",
      callId: "call_1",
      content: "Tool 'bash' is not available in this agent.",
    },
  ]);
});

test("agent records assistant reasoning and tool calls", async () => {
  const model = modelWithPasses([
    [
      { type: "reasoning_summary.delta", delta: "Need a tool.", raw: {} },
      { type: "text.delta", delta: "Checking...", raw: {} },
      toolCall("call_1", "bash", {}),
      { type: "completed", raw: {} },
    ],
    [{ type: "completed", raw: {} }],
  ]);
  const { agent, conversations, conversation } = await createHarness({ model });

  await collectTurn(
    agent.runTurn({ conversationId: conversation.id, userMessage: "Inspect." }),
  );
  const context = await conversations.buildContext(conversation.id);

  expect(context.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool_result",
    "assistant",
  ]);
  expect(context.messages[1]?.content).toEqual([
    { type: "reasoning_summary", text: "Need a tool." },
    { type: "text", text: "Checking..." },
    { type: "tool_call", raw: { callId: "call_1", name: "bash", input: {} } },
  ]);
});

test("agent turn yields streaming text before the model finishes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-streaming-"));
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
  let releaseModel: () => void = () => undefined;
  const modelGate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const model = {
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text.delta", delta: "streamed", raw: {} };
      await modelGate;
      yield { type: "completed", raw: {} };
    },
  };
  const memory = new SimpleLinearMemory(conversations);
  const agent = new Agent({
    memory,
    model,
    tools: new ToolRegistry([]),
  });

  const iterator = agent.runTurn({
    conversationId: conversation.id,
    userMessage: "Say hi.",
  });
  const first = await iterator.next();

  expect(first).toEqual({
    done: false,
    value: { type: "text.delta", delta: "streamed" },
  });

  releaseModel();
  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: { type: "completed" },
  });
});

test("agent completes a turn without a tool recovery pass when no tools are requested", async () => {
  const model = new RecordingModelClient(
    async function* (_request): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text.delta", delta: "Hello.", raw: {} };
      yield { type: "completed", raw: {} };
    },
  );
  const {
    agent,
    conversations,
    conversation,
    model: recordedModel,
  } = await createHarness({
    model,
  });

  const events = await collectTurn(
    agent.runTurn({ conversationId: conversation.id, userMessage: "Hi." }),
  );
  const context = await conversations.buildContext(conversation.id);

  expect(events.map((event) => event.type)).toEqual([
    "text.delta",
    "completed",
  ]);
  expect(recordedModel.requests).toHaveLength(1);
  expect(context.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);
  expect(context.messages[1]?.content).toEqual([
    { type: "text", text: "Hello." },
  ]);
});

test("agent records failed model events as assistant errors", async () => {
  const { agent, conversations, conversation } = await createHarness({
    model: new RecordingModelClient(
      async function* (): AsyncGenerator<ModelStreamEvent> {
        yield {
          type: "failed",
          error: "model rejected request",
          raw: { id: "err" },
        };
      },
    ),
  });

  const events = await collectTurn(
    agent.runTurn({ conversationId: conversation.id, userMessage: "Hi." }),
  );
  const context = await conversations.buildContext(conversation.id);

  expect(events).toEqual([{ type: "completed" }]);
  expect(context.messages[1]?.content).toEqual([
    { type: "error", text: "model rejected request", raw: { id: "err" } },
  ]);
});

test("agent propagates thrown model errors after recording the user message", async () => {
  const { agent, conversations, conversation } = await createHarness({
    model: new RecordingModelClient(
      async function* (): AsyncGenerator<ModelStreamEvent> {
        const shouldThrow = true;
        if (shouldThrow) {
          throw new Error("transport down");
        }
        yield { type: "completed", raw: {} };
      },
    ),
  });

  await expect(
    collectTurn(
      agent.runTurn({ conversationId: conversation.id, userMessage: "Hi." }),
    ),
  ).rejects.toThrow("transport down");
  const context = await conversations.buildContext(conversation.id);

  expect(context.messages.map((message) => message.role)).toEqual(["user"]);
});

test("agent propagates thrown tool errors and leaves the tool turn open", async () => {
  const { agent, conversations, conversation } = await createHarness(
    {
      model: new RecordingModelClient(
        async function* (): AsyncGenerator<ModelStreamEvent> {
          yield {
            type: "tool_call",
            callId: "call_1",
            name: "explode",
            input: {},
            raw: {},
          };
          yield { type: "completed", raw: {} };
        },
      ),
    },
    [new ThrowingTool()],
  );

  await expect(
    collectTurn(
      agent.runTurn({ conversationId: conversation.id, userMessage: "Hi." }),
    ),
  ).rejects.toThrow("tool exploded");
  const context = await conversations.buildContext(conversation.id);

  expect(context.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);
  expect(context.messages[1]?.content).toEqual([
    {
      type: "tool_call",
      raw: { callId: "call_1", name: "explode", input: {} },
    },
  ]);
});

async function createHarness(
  dependencies: { readonly model: RecordingModelClient },
  tools: readonly Tool[] = [],
) {
  const cwd = await mkdtemp(join(tmpdir(), "agent-harness-"));
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

  return {
    agent: new Agent({
      memory,
      model: dependencies.model,
      tools: new ToolRegistry(tools),
    }),
    conversations,
    conversation,
    model: dependencies.model,
  };
}

async function collectTurn(
  generator: AsyncGenerator<AgentTurnEvent>,
): Promise<AgentTurnEvent[]> {
  const events: AgentTurnEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

function eventTypes(events: readonly AgentTurnEvent[]): string[] {
  return events.map((event) => event.type);
}

function modelWithPasses(
  passes: readonly (readonly ModelStreamEvent[])[],
): RecordingModelClient {
  let passIndex = 0;
  return new RecordingModelClient(async function* () {
    const events = passes[passIndex] ?? [];
    passIndex += 1;
    yield* events;
  });
}

function toolCall(
  callId: string,
  name: string,
  input: unknown,
): ModelStreamEvent {
  return { type: "tool_call", callId, name, input, raw: {} };
}

class RecordingModelClient {
  readonly requests: ModelRequest[] = [];
  readonly #stream: (request: ModelRequest) => AsyncIterable<ModelStreamEvent>;

  constructor(
    stream: (request: ModelRequest) => AsyncIterable<ModelStreamEvent>,
  ) {
    this.#stream = stream;
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    this.requests.push(request);
    yield* this.#stream(request);
  }
}

class ThrowingTool implements Tool {
  readonly definition = {
    name: "explode",
    description: "Throws an error.",
    inputSchema: {},
  };

  async execute(_request: ToolCallRequest): Promise<ToolCallResult> {
    throw new Error("tool exploded");
  }
}
