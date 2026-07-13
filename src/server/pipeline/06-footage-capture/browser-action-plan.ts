export type BrowserLocator =
  | {
      exact?: boolean;
      name?: string;
      role: string;
      strategy: "role";
    }
  | {
      exact?: boolean;
      strategy: "label" | "placeholder" | "text";
      value: string;
    }
  | { strategy: "css" | "test-id" | "xpath"; value: string };

type BrowserActionBase = {
  id: string;
  locatorCandidateId?: string;
  sourceActionId?: string;
};

export type BrowserAction =
  | (BrowserActionBase & { path: string; type: "goto" })
  | (BrowserActionBase & {
      locator: BrowserLocator;
      type: "click" | "hover" | "assert-visible";
    })
  | (BrowserActionBase & {
      locator: BrowserLocator;
      position: "bottom" | "top";
      type: "scroll";
    })
  | (BrowserActionBase & {
      locator: BrowserLocator;
      type: "fill" | "select-option";
      value: string;
    })
  | (BrowserActionBase & {
      key: string;
      locator: BrowserLocator;
      type: "press";
    })
  | (BrowserActionBase & {
      locator: BrowserLocator;
      text: string;
      type: "assert-text";
    })
  | (BrowserActionBase & { path: string; type: "assert-url" })
  | (BrowserActionBase & { text: string; type: "assert-title" });

export type BrowserScenePlan = {
  actions: BrowserAction[];
  id: string;
};

const actionKeysByType = {
  "assert-text": [
    "id",
    "locator",
    "locatorCandidateId",
    "sourceActionId",
    "text",
    "type",
  ],
  "assert-title": [
    "id",
    "locatorCandidateId",
    "sourceActionId",
    "text",
    "type",
  ],
  "assert-url": ["id", "locatorCandidateId", "path", "sourceActionId", "type"],
  "assert-visible": [
    "id",
    "locator",
    "locatorCandidateId",
    "sourceActionId",
    "type",
  ],
  click: ["id", "locator", "locatorCandidateId", "sourceActionId", "type"],
  fill: [
    "id",
    "locator",
    "locatorCandidateId",
    "sourceActionId",
    "type",
    "value",
  ],
  goto: ["id", "locatorCandidateId", "path", "sourceActionId", "type"],
  hover: ["id", "locator", "locatorCandidateId", "sourceActionId", "type"],
  press: [
    "id",
    "key",
    "locator",
    "locatorCandidateId",
    "sourceActionId",
    "type",
  ],
  scroll: [
    "id",
    "locator",
    "locatorCandidateId",
    "position",
    "sourceActionId",
    "type",
  ],
  "select-option": [
    "id",
    "locator",
    "locatorCandidateId",
    "sourceActionId",
    "type",
    "value",
  ],
} as const;

type BrowserActionType = keyof typeof actionKeysByType;

const localAppPathPatternSource = "^(?:/(?!/)|#|\\?).*$";
const localAppPathPattern = new RegExp(localAppPathPatternSource);

/**
 * Parses backend-compilable browser actions. Implementations consuming these
 * actions may rely on local-only navigation and strict, known action fields.
 */
export function readBrowserActions(
  value: unknown,
  path = "actions",
): BrowserAction[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }

  const seenActionIds = new Set<string>();
  return value.map((entry, index) => {
    const action = readBrowserAction(entry, `${path}[${index}]`);
    if (seenActionIds.has(action.id)) {
      throw new Error(`${path}[${index}].id must be unique within ${path}`);
    }
    seenActionIds.add(action.id);
    return action;
  });
}

/** Returns the strict agent-facing JSON Schema for backend-compilable actions. */
export function createBrowserActionJsonSchema() {
  const locator = {
    oneOf: [
      {
        additionalProperties: false,
        properties: {
          exact: { type: "boolean" },
          name: { minLength: 1, type: "string" },
          role: { minLength: 1, type: "string" },
          strategy: { const: "role" },
        },
        required: ["strategy", "role"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          exact: { type: "boolean" },
          strategy: { enum: ["label", "placeholder", "text"] },
          value: { minLength: 1, type: "string" },
        },
        required: ["strategy", "value"],
        type: "object",
      },
      {
        additionalProperties: false,
        properties: {
          strategy: { enum: ["css", "test-id", "xpath"] },
          value: { minLength: 1, type: "string" },
        },
        required: ["strategy", "value"],
        type: "object",
      },
    ],
  } as const;
  const commonProperties = {
    id: { pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$", type: "string" },
    locatorCandidateId: {
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
      type: "string",
    },
    sourceActionId: {
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",
      type: "string",
    },
  } as const;
  const schema = (
    type: BrowserActionType,
    properties: Record<string, unknown>,
    required: string[],
  ) => ({
    additionalProperties: false as const,
    properties: {
      ...commonProperties,
      ...properties,
      type: { const: type },
    },
    required: ["id", "type", ...required],
    type: "object" as const,
  });

  return {
    items: {
      oneOf: [
        schema(
          "goto",
          {
            path: {
              minLength: 1,
              pattern: localAppPathPatternSource,
              type: "string",
            },
          },
          ["path"],
        ),
        schema("click", { locator }, ["locator"]),
        schema("hover", { locator }, ["locator"]),
        schema("scroll", { locator, position: { enum: ["bottom", "top"] } }, [
          "locator",
          "position",
        ]),
        schema("fill", { locator, value: { type: "string" } }, [
          "locator",
          "value",
        ]),
        schema("press", { key: { minLength: 1, type: "string" }, locator }, [
          "key",
          "locator",
        ]),
        schema(
          "select-option",
          { locator, value: { minLength: 1, type: "string" } },
          ["locator", "value"],
        ),
        schema("assert-visible", { locator }, ["locator"]),
        schema(
          "assert-text",
          { locator, text: { minLength: 1, type: "string" } },
          ["locator", "text"],
        ),
        schema(
          "assert-url",
          {
            path: {
              minLength: 1,
              pattern: localAppPathPatternSource,
              type: "string",
            },
          },
          ["path"],
        ),
        schema("assert-title", { text: { minLength: 1, type: "string" } }, [
          "text",
        ]),
      ],
    },
    type: "array" as const,
  };
}

/** Compiles a typed browser plan into the backend-owned Capture SDK syntax. */
export function compileBrowserActionPlan(input: {
  scenes: BrowserScenePlan[];
  setupActions?: BrowserAction[];
}): string {
  for (const scene of input.scenes) {
    if (
      !scene.actions.some(
        (action) =>
          action.type === "assert-visible" || action.type === "assert-text",
      )
    ) {
      throw new Error(
        `Browser scene ${scene.id} must include a visible assertion action`,
      );
    }
  }

  const lines = [
    "import { setup, scene, step } from './makeademo-capture-sdk';",
    "",
    "await setup(async ({ page, baseUrl, expect }) => {",
    "  await page.goto(baseUrl);",
    ...compileActions(input.setupActions ?? [], "  "),
    "  void expect;",
    "});",
  ];

  for (const scene of input.scenes) {
    lines.push(
      "",
      `await scene(${JSON.stringify(scene.id)}, async ({ page, baseUrl, expect }) => {`,
      ...compileActions(scene.actions, "  "),
      "  void baseUrl;",
      "});",
    );
  }

  return lines.join("\n");
}

function readBrowserAction(value: unknown, path: string): BrowserAction {
  const record = readRecord(value, path);
  const type = readActionType(record.type, `${path}.type`);
  assertOnlyKeys(record, actionKeysByType[type], path);
  const common = {
    id: readId(record.id, `${path}.id`),
    ...(record.locatorCandidateId === undefined
      ? {}
      : {
          locatorCandidateId: readId(
            record.locatorCandidateId,
            `${path}.locatorCandidateId`,
          ),
        }),
    ...(record.sourceActionId === undefined
      ? {}
      : {
          sourceActionId: readId(
            record.sourceActionId,
            `${path}.sourceActionId`,
          ),
        }),
  };

  if (type === "goto" || type === "assert-url") {
    return {
      ...common,
      path: readLocalPath(record.path, `${path}.path`),
      type,
    };
  }
  if (type === "assert-title") {
    return { ...common, text: readString(record.text, `${path}.text`), type };
  }

  const locator = readBrowserLocator(record.locator, `${path}.locator`);
  if (type === "scroll") {
    const position = readString(record.position, `${path}.position`);
    if (position !== "bottom" && position !== "top") {
      throw new Error(`${path}.position is unsupported`);
    }
    return {
      ...common,
      locator,
      position,
      type,
    };
  }
  if (type === "fill") {
    return {
      ...common,
      locator,
      type,
      value: readStringAllowingEmpty(record.value, `${path}.value`),
    };
  }
  if (type === "select-option") {
    return {
      ...common,
      locator,
      type,
      value: readString(record.value, `${path}.value`),
    };
  }
  if (type === "press") {
    return {
      ...common,
      key: readString(record.key, `${path}.key`),
      locator,
      type,
    };
  }
  if (type === "assert-text") {
    return {
      ...common,
      locator,
      text: readString(record.text, `${path}.text`),
      type,
    };
  }

  return { ...common, locator, type };
}

/** Parses the shared browser locator vocabulary used by catalog evidence and capture plans. */
export function readBrowserLocator(
  value: unknown,
  path: string,
): BrowserLocator {
  const record = readRecord(value, path);
  const strategy = readString(record.strategy, `${path}.strategy`);

  if (strategy === "role") {
    assertOnlyKeys(record, ["exact", "name", "role", "strategy"], path);
    return {
      ...(record.exact === undefined
        ? {}
        : { exact: readBoolean(record.exact, `${path}.exact`) }),
      ...(record.name === undefined
        ? {}
        : { name: readString(record.name, `${path}.name`) }),
      role: readString(record.role, `${path}.role`),
      strategy,
    };
  }
  if (
    strategy === "label" ||
    strategy === "placeholder" ||
    strategy === "text"
  ) {
    assertOnlyKeys(record, ["exact", "strategy", "value"], path);
    return {
      ...(record.exact === undefined
        ? {}
        : { exact: readBoolean(record.exact, `${path}.exact`) }),
      strategy,
      value: readString(record.value, `${path}.value`),
    };
  }
  if (strategy === "css" || strategy === "test-id" || strategy === "xpath") {
    assertOnlyKeys(record, ["strategy", "value"], path);
    return {
      strategy,
      value: readString(record.value, `${path}.value`),
    };
  }

  throw new Error(`${path}.strategy is unsupported`);
}

function compileActions(actions: BrowserAction[], indent: string): string[] {
  return actions.flatMap((action) => [
    `${indent}await step(${JSON.stringify(action.id)}, async () => {`,
    ...compileAction(action).map((line) => `${indent}  ${line}`),
    `${indent}});`,
  ]);
}

function compileAction(action: BrowserAction): string[] {
  if (action.type === "goto") {
    return [
      `await page.goto(new URL(${JSON.stringify(action.path)}, baseUrl).toString());`,
    ];
  }
  if (action.type === "assert-url") {
    return [
      `await expect(page).toHaveURL(new URL(${JSON.stringify(action.path)}, baseUrl).toString());`,
    ];
  }
  if (action.type === "assert-title") {
    return [`await expect(page).toHaveTitle(${JSON.stringify(action.text)});`];
  }

  const locator = compileLocator(action.locator);
  if (action.type === "click" || action.type === "hover") {
    return [`await ${locator}.${action.type}();`];
  }
  if (action.type === "fill") {
    return [`await ${locator}.fill(${JSON.stringify(action.value)});`];
  }
  if (action.type === "press") {
    return [`await ${locator}.press(${JSON.stringify(action.key)});`];
  }
  if (action.type === "select-option") {
    return [`await ${locator}.selectOption(${JSON.stringify(action.value)});`];
  }
  if (action.type === "scroll") {
    return action.position === "bottom"
      ? [
          `await ${locator}.evaluate((element) => { element.scrollTop = element.scrollHeight; });`,
        ]
      : [`await ${locator}.evaluate((element) => { element.scrollTop = 0; });`];
  }
  if (action.type === "assert-text") {
    return [
      `await expect(${locator}).toBeVisible();`,
      `await expect(${locator}).toContainText(${JSON.stringify(action.text)});`,
    ];
  }

  return [`await expect(${locator}).toBeVisible();`];
}

function compileLocator(locator: BrowserLocator): string {
  if (locator.strategy === "role") {
    const optionFields = [
      ...(locator.name === undefined
        ? []
        : [`name: ${JSON.stringify(locator.name)}`]),
      ...(locator.exact === undefined ? [] : [`exact: ${locator.exact}`]),
    ];
    const optionsSource =
      optionFields.length === 0 ? "" : `, { ${optionFields.join(", ")} }`;
    return `page.getByRole(${JSON.stringify(locator.role)}${optionsSource})`;
  }

  if (locator.strategy === "test-id") {
    return `page.getByTestId(${JSON.stringify(locator.value)})`;
  }
  if (locator.strategy === "css") {
    return `page.locator(${JSON.stringify(locator.value)})`;
  }
  if (locator.strategy === "xpath") {
    const selector = locator.value.startsWith("xpath=")
      ? locator.value
      : `xpath=${locator.value}`;
    return `page.locator(${JSON.stringify(selector)})`;
  }

  const method = {
    label: "getByLabel",
    placeholder: "getByPlaceholder",
    text: "getByText",
  }[locator.strategy];
  const exact =
    !("exact" in locator) || locator.exact === undefined
      ? ""
      : `, { exact: ${locator.exact} }`;
  return `page.${method}(${JSON.stringify(locator.value)}${exact})`;
}

function readActionType(value: unknown, path: string): BrowserActionType {
  const type = readString(value, path);
  if (!(type in actionKeysByType)) {
    throw new Error(`${path} is unsupported`);
  }
  return type as BrowserActionType;
}

function readLocalPath(value: unknown, path: string): string {
  const route = readString(value, path);
  if (!localAppPathPattern.test(route)) {
    throw new Error(`${path} must be a local app path`);
  }
  return route;
}

function readId(value: unknown, path: string): string {
  const id = readString(value, path);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    throw new Error(`${path} must be a safe identifier`);
  }
  return id;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function readStringAllowingEmpty(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  return value;
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`${path} contains unsupported property ${key}`);
    }
  }
}
