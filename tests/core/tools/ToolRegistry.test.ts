import { MathTool } from "../../../src/adapters/tools/MathTool";
import type {
  Tool,
  ToolCallRequest,
  ToolCallResult,
} from "../../../src/core/tools/Tool.interface";
import { ToolRegistry } from "../../../src/core/tools/ToolRegistry";

test("tool registry lists definitions from registered tools", async () => {
  const registry = new ToolRegistry([new MathTool()]);

  await expect(registry.list()).resolves.toEqual([
    expect.objectContaining({ name: "math" }),
  ]);
});

test("tool registry lists a deterministic tool catalog", async () => {
  const first = new ToolRegistry([
    new TestTool("zeta", { type: "object", properties: { b: {}, a: {} } }),
    new TestTool("alpha", { type: "object", properties: { d: {}, c: {} } }),
  ]);
  const second = new ToolRegistry([
    new TestTool("alpha", { properties: { c: {}, d: {} }, type: "object" }),
    new TestTool("zeta", { properties: { a: {}, b: {} }, type: "object" }),
  ]);

  const firstCatalog = await first.list();
  const secondCatalog = await second.list();

  expect(firstCatalog).toEqual(secondCatalog);
  expect(firstCatalog.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
  expect(Object.keys(firstCatalog[0]?.inputSchema ?? {})).toEqual([
    "properties",
    "type",
  ]);
  expect(Object.keys(firstCatalog[0]?.inputSchema.properties ?? {})).toEqual([
    "c",
    "d",
  ]);
});

test("tool registry canonicalizes nested schema objects without reordering arrays", async () => {
  const registry = new ToolRegistry([
    new TestTool("nested", {
      type: "object",
      required: ["z", "a"],
      properties: {
        z: { type: "string", enum: ["b", "a"] },
        a: { description: "first", type: "number" },
      },
    }),
  ]);

  const [tool] = await registry.list();

  expect(Object.keys(tool?.inputSchema ?? {})).toEqual([
    "properties",
    "required",
    "type",
  ]);
  expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["a", "z"]);
  expect(tool?.inputSchema.required).toEqual(["z", "a"]);
  expect(
    (tool?.inputSchema.properties as Record<string, Record<string, unknown>>).z
      ?.enum,
  ).toEqual(["b", "a"]);
});

test("tool registry dispatches calls to the matching tool", async () => {
  const registry = new ToolRegistry([new MathTool()]);

  await expect(
    execute(registry, "math", { operation: "add", left: 2, right: 3 }),
  ).resolves.toEqual({
    callId: "call_1",
    name: "math",
    output: "5",
    isError: false,
  });
});

test("tool registry dispatches duplicate names to the last registered tool", async () => {
  const registry = new ToolRegistry([
    new TestTool("duplicate", {}, "first"),
    new TestTool("duplicate", {}, "second"),
  ]);

  await expect(execute(registry, "duplicate")).resolves.toEqual({
    callId: "call_1",
    name: "duplicate",
    output: "second",
    isError: false,
  });
});

test("tool registry lists duplicate names as the last registered definition", async () => {
  const registry = new ToolRegistry([
    new TestTool("duplicate", {}, "first"),
    new TestTool("duplicate", {}, "second"),
  ]);

  await expect(registry.list()).resolves.toEqual([
    expect.objectContaining({ description: "duplicate test tool second" }),
  ]);
});

test("tool registry propagates tool execution failures", async () => {
  const registry = new ToolRegistry([new ThrowingTool()]);

  await expect(execute(registry, "throws")).rejects.toThrow("tool failed");
});

test("tool registry returns structured errors for missing tools", async () => {
  const registry = new ToolRegistry([]);

  await expect(execute(registry, "missing")).resolves.toEqual({
    callId: "call_1",
    name: "missing",
    output: "Tool 'missing' is not available in this agent.",
    isError: true,
  });
});

function execute(
  registry: ToolRegistry,
  name: string,
  input: unknown = {},
): Promise<ToolCallResult> {
  return registry.execute({ callId: "call_1", name, input });
}

class TestTool implements Tool {
  readonly definition;
  readonly #output: string;

  constructor(
    name: string,
    inputSchema: Readonly<Record<string, unknown>>,
    output = "ok",
  ) {
    this.#output = output;
    this.definition = {
      name,
      description: `${name} test tool ${output}`,
      inputSchema,
    };
  }

  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    return {
      callId: request.callId,
      name: request.name,
      output: this.#output,
      isError: false,
    };
  }
}

class ThrowingTool implements Tool {
  readonly definition = {
    name: "throws",
    description: "Throws.",
    inputSchema: {},
  };

  async execute(_request: ToolCallRequest): Promise<ToolCallResult> {
    throw new Error("tool failed");
  }
}
