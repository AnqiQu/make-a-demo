import type {
  Tool,
  ToolCallRequest,
  ToolCallResult,
  ToolDefinition,
} from "../../core/tools/Tool.interface";

const MATH_TOOL: ToolDefinition = {
  name: "math",
  description:
    "Performs basic arithmetic: addition, subtraction, multiplication, and division.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["add", "subtract", "multiply", "divide"],
      },
      left: { type: "number" },
      right: { type: "number" },
    },
    required: ["operation", "left", "right"],
    additionalProperties: false,
  },
};

type MathOperation = "add" | "subtract" | "multiply" | "divide";

interface MathInput {
  readonly operation: MathOperation;
  readonly left: number;
  readonly right: number;
}

/** Demonstration tool for basic arithmetic. */
export class MathTool implements Tool {
  readonly definition = MATH_TOOL;

  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    const rawInput = parseMathInput(request.input);
    if (typeof rawInput === "string") {
      return toolErrorResult(request, rawInput);
    }

    if (rawInput.operation === "divide" && rawInput.right === 0) {
      return toolErrorResult(request, "Cannot divide by zero.");
    }

    return {
      callId: request.callId,
      name: request.name,
      output: String(calculateMathResult(rawInput)),
      isError: false,
    };
  }
}

function parseMathInput(rawInput: unknown): MathInput | string {
  if (!rawInput || typeof rawInput !== "object") {
    return "Math input must be an object.";
  }
  const inputObject = rawInput as Record<string, unknown>;
  if (!isOperation(inputObject.operation)) {
    return "Math operation must be add, subtract, multiply, or divide.";
  }
  if (
    typeof inputObject.left !== "number" ||
    typeof inputObject.right !== "number"
  ) {
    return "Math operands must be numbers.";
  }
  return {
    operation: inputObject.operation,
    left: inputObject.left,
    right: inputObject.right,
  };
}

function isOperation(value: unknown): value is MathOperation {
  return (
    value === "add" ||
    value === "subtract" ||
    value === "multiply" ||
    value === "divide"
  );
}

function calculateMathResult(input: MathInput): number {
  switch (input.operation) {
    case "add":
      return input.left + input.right;
    case "subtract":
      return input.left - input.right;
    case "multiply":
      return input.left * input.right;
    case "divide":
      return input.left / input.right;
  }
}

function toolErrorResult(
  request: ToolCallRequest,
  output: string,
): ToolCallResult {
  return {
    callId: request.callId,
    name: request.name,
    output,
    isError: true,
  };
}
