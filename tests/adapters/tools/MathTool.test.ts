import { MathTool } from "../../../src/adapters/tools/MathTool";

test("math tool exposes a calculator definition", () => {
  const tool = new MathTool();

  expect(tool.definition).toEqual(
    expect.objectContaining({
      name: "math",
      description: expect.stringContaining("addition"),
    }),
  );
});

test.each([
  ["add", 2, 3, "5"],
  ["subtract", 7, 4, "3"],
  ["multiply", 6, 5, "30"],
  ["divide", 8, 2, "4"],
] as const)(
  "math tool can %s numbers",
  async (operation, left, right, output) => {
    const tool = new MathTool();

    await expect(
      tool.execute({
        callId: "call_1",
        name: "math",
        input: { operation, left, right },
      }),
    ).resolves.toEqual({
      callId: "call_1",
      name: "math",
      output,
      isError: false,
    });
  },
);

test("math tool returns structured errors for invalid requests", async () => {
  const tool = new MathTool();

  await expect(
    tool.execute({
      callId: "call_1",
      name: "math",
      input: { operation: "divide", left: 1, right: 0 },
    }),
  ).resolves.toEqual({
    callId: "call_1",
    name: "math",
    output: "Cannot divide by zero.",
    isError: true,
  });
});
