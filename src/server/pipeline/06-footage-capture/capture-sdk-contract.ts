import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CAPTURE_SDK_CONTRACT_VERSION } from "./capture-contract-versions";
import type { DemoScript } from "./demo-script.schema";

const visibleAssertionMatchers = ["toBeInViewport", "toBeVisible"] as const;

/**
 * Returns the backend-owned Capture SDK runtime contract. Script Writing uses
 * typed browser actions; this artifact explains the generated execution layer
 * and is not a template for agent-authored source.
 */
export function createCaptureSdkAgentContract() {
  return {
    canonicalExample: [
      "import { setup, scene, step } from './makeademo-capture-sdk';",
      "",
      "await setup(async ({ page, baseUrl, expect }) => {",
      '  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });',
      "  await expect(page.locator('body')).toBeVisible();",
      "});",
      "",
      "await scene('scene_main', async ({ page, expect }) => {",
      "  await step('assert-main-content', async () => {",
      "    await expect(page.getByRole('heading', { name: 'Main content' })).toBeVisible();",
      "  });",
      "});",
    ].join("\n"),
    contractVersion: CAPTURE_SDK_CONTRACT_VERSION,
    declarations: declarationSource(),
    instructions: instructionsSource(),
    visibleAssertionMatchers,
  } as const;
}

export async function writeGeneratedCaptureSdkHarness(
  directory: string,
): Promise<void> {
  await Promise.all([
    writeFile(join(directory, "makeademo-capture-sdk.js"), runtimeSource()),
    writeFile(
      join(directory, "makeademo-capture-sdk.d.ts"),
      declarationSource(),
    ),
    writeFile(
      join(directory, "makeademo-capture-sdk.instructions.md"),
      instructionsSource(),
    ),
  ]);
}

export async function validateDemoScriptCaptureSdkTypes(input: {
  demoPlaywrightScript: string;
  directory: string;
}): Promise<void> {
  const contractScriptName = "demo-script.contract.ts";
  const contractScriptPath = join(input.directory, contractScriptName);
  await writeFile(contractScriptPath, input.demoPlaywrightScript);

  const result = await runTypeScriptCheck({
    cwd: input.directory,
    scriptPath: contractScriptName,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Demo Script failed Capture SDK TypeScript validation.\n${[
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n")}`,
    );
  }
}

async function runTypeScriptCheck(input: { cwd: string; scriptPath: string }) {
  return await new Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const child = spawn(
      "bunx",
      [
        "tsc",
        "--noEmit",
        "--pretty",
        "false",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        "--strict",
        "--skipLibCheck",
        "--lib",
        "ES2022,DOM,DOM.Iterable",
        input.scriptPath,
      ],
      { cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}

function runtimeSource() {
  return `export async function setup() {
  const sdk = readMakeADemoCaptureSdk();
  const callback = arguments[0];
  await runWithActiveScene(sdk, 'setup', () =>
    callback(createInstrumentedContext(sdk, 'setup')),
  );
}

export async function scene() {
  const sdk = readMakeADemoCaptureSdk();
  const id = arguments[0];
  const callback = arguments[1];
  // Generated protocol: parent validators/recorders parse these stdout markers for Scene timing.
  console.log('[makeademo:scene]', JSON.stringify({ elapsedMs: elapsedMs(sdk), event: 'started', sceneId: id }));
  try {
    await runWithActiveScene(sdk, id, async () => {
      await callback(createInstrumentedContext(sdk, id));
      const holdMs = sdk.sceneHoldMsById?.[id] ?? 0;
      if (holdMs > 0) {
        await sdk.context.page.waitForTimeout(holdMs);
      }
    });
    console.log('[makeademo:scene]', JSON.stringify({ elapsedMs: elapsedMs(sdk), event: 'succeeded', sceneId: id }));
  } catch (error) {
    console.log('[makeademo:scene]', JSON.stringify({
      elapsedMs: elapsedMs(sdk),
      event: 'failed',
      message: error instanceof Error ? error.message : String(error),
      sceneId: id,
    }));
    throw error;
  }
}

export async function step() {
  const sdk = readMakeADemoCaptureSdk();
  const stepId = arguments[0];
  const callback = arguments[1];
  const sceneId = sdk.activeSceneId;
  if (typeof sceneId !== 'string') {
    throw new Error('MakeADemo Capture SDK step() must run inside setup() or scene().');
  }

  console.log('[makeademo:step]', JSON.stringify({
    elapsedMs: elapsedMs(sdk),
    event: 'started',
    stepId,
    sceneId,
  }));
  try {
    const result = await callback();
    console.log('[makeademo:step]', JSON.stringify({
      elapsedMs: elapsedMs(sdk),
      event: 'succeeded',
      stepId,
      sceneId,
    }));
    return result;
  } catch (error) {
    console.log('[makeademo:step]', JSON.stringify({
      elapsedMs: elapsedMs(sdk),
      event: 'failed',
      message: error instanceof Error ? error.message : String(error),
      stepId,
      sceneId,
    }));
    throw error;
  }
}

async function runWithActiveScene(sdk, sceneId, callback) {
  if (sdk.activeSceneId !== undefined) {
    throw new Error('MakeADemo Capture SDK setup() and scene() calls must not be nested or concurrent.');
  }
  sdk.activeSceneId = sceneId;
  try {
    return await callback();
  } finally {
    delete sdk.activeSceneId;
  }
}

function readMakeADemoCaptureSdk() {
  const sdk = globalThis.__makeademoCaptureSdk;
  if (!sdk || !sdk.context || typeof sdk.startedAt !== 'number') {
    throw new Error('MakeADemo Capture SDK was loaded outside a validation/capture harness.');
  }
  return sdk;
}

function elapsedMs(sdk) {
  return Math.max(0, Math.round(performance.now() - sdk.startedAt));
}

function createInstrumentedContext(sdk, sceneId) {
  const timeoutMs = typeof sdk.actionTimeoutMs === 'number'
    ? sdk.actionTimeoutMs
    : undefined;
  return {
    ...sdk.context,
    expect: instrumentExpect(sdk.context.expect, sdk, sceneId, timeoutMs),
    page: instrumentPage(sdk.context.page, sdk, sceneId, timeoutMs),
  };
}

const makeADemoPageActionMethods = new Set([
  'check',
  'click',
  'dblclick',
  'fill',
  'focus',
  'goto',
  'hover',
  'press',
  'reload',
  'selectOption',
  'tap',
  'type',
  'uncheck',
  'waitForFunction',
  'waitForLoadState',
  'waitForRequest',
  'waitForResponse',
  'waitForSelector',
  'waitForTimeout',
]);
const makeADemoLocatorActionMethods = new Set([
  'blur',
  'check',
  'clear',
  'click',
  'dblclick',
  'fill',
  'focus',
  'hover',
  'press',
  'scrollIntoViewIfNeeded',
  'selectOption',
  'tap',
  'type',
  'uncheck',
  'waitFor',
]);
const makeADemoLocatorFactoryMethods = new Set([
  'frameLocator',
  'getByAltText',
  'getByLabel',
  'getByPlaceholder',
  'getByRole',
  'getByTestId',
  'getByText',
  'getByTitle',
  'locator',
]);
const makeADemoLocatorChainMethods = new Set([
  'filter',
  'first',
  'getByAltText',
  'getByLabel',
  'getByPlaceholder',
  'getByRole',
  'getByTestId',
  'getByText',
  'getByTitle',
  'last',
  'locator',
  'nth',
]);
const makeADemoExpectAssertionMethods = new Set([
  'toBeDisabled',
  'toBeEnabled',
  'toBeHidden',
  'toBeInViewport',
  'toBeVisible',
  'toContainText',
  'toHaveAttribute',
  'toHaveCount',
  'toHaveText',
  'toHaveTitle',
  'toHaveURL',
  'toHaveValue',
]);
const makeADemoRawInstrumentedObjects = new WeakMap();

function instrumentPage(page, sdk, sceneId, timeoutMs) {
  return rememberInstrumentedObject(page, new Proxy(page, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') {
        return value;
      }

      if (makeADemoLocatorFactoryMethods.has(property)) {
        return (...args) => {
          const locator = value.apply(target, args);
          return instrumentLocator(locator, sdk, sceneId, property, formatActionArguments(args), timeoutMs);
        };
      }

      if (property === 'waitForURL') {
        return (...args) =>
          value.apply(
            target,
            withPageActionTimeoutOptions(property, args, timeoutMs),
          );
      }

      if (!makeADemoPageActionMethods.has(property)) {
        return value.bind(target);
      }

      return (...args) =>
        runInstrumentedStep({
          callback: () =>
            property === 'waitForTimeout'
              ? runBoundedWaitForTimeout(value, target, args, timeoutMs)
              : value.apply(
                  target,
                  withPageActionTimeoutOptions(property, args, timeoutMs),
                ),
          label: \`page.\${property}(\${formatActionArguments(args)})\`,
          sceneId,
          sdk,
          timeoutMs,
        });
    },
  }));
}

function instrumentLocator(locator, sdk, sceneId, source, sourceArguments, timeoutMs) {
  const sourceLabel = sourceArguments.length > 0
    ? \`\${source}(\${sourceArguments})\`
    : source;
  return rememberInstrumentedObject(locator, new Proxy(locator, {
    get(target, property, receiver) {
      if (property === '__makeademoDescription') {
        return sourceLabel;
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') {
        return value;
      }

      if (makeADemoLocatorChainMethods.has(property)) {
        return (...args) => {
          const nextLocator = value.apply(target, args);
          return instrumentLocator(
            nextLocator,
            sdk,
            sceneId,
            \`\${sourceLabel}.\${property}\`,
            formatActionArguments(args),
            timeoutMs,
          );
        };
      }

      if (!makeADemoLocatorActionMethods.has(property)) {
        return value.bind(target);
      }

      return (...args) =>
        runInstrumentedStep({
          callback: () =>
            value.apply(
              target,
              withLocatorActionTimeoutOptions(property, args, timeoutMs),
            ),
          label: \`locator.\${property}(\${[sourceLabel, formatActionArguments(args)].filter(Boolean).join(', ')})\`,
          sceneId,
          sdk,
          timeoutMs,
        });
    },
  }));
}

function instrumentExpect(playwrightExpect, sdk, sceneId, timeoutMs) {
  return (actual, ...args) => {
    const assertion = playwrightExpect(unwrapInstrumentedObject(actual), ...args);
    return new Proxy(assertion, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (
          typeof property !== 'string' ||
          typeof value !== 'function' ||
          !makeADemoExpectAssertionMethods.has(property)
        ) {
          return typeof value === 'function' ? value.bind(target) : value;
        }

        return (...assertionArgs) =>
          runInstrumentedStep({
            callback: () => value.apply(target, withTimeoutOptions(assertionArgs, timeoutMs)),
            label: \`expect.\${property}(\${describeAssertionSubject(actual)})\`,
            sceneId,
            sdk,
            timeoutMs,
          });
      },
    });
  };
}

function rememberInstrumentedObject(raw, instrumented) {
  makeADemoRawInstrumentedObjects.set(instrumented, raw);
  return instrumented;
}

function unwrapInstrumentedObject(value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return value;
  }
  return makeADemoRawInstrumentedObjects.get(value) ?? value;
}

async function runInstrumentedStep(input) {
  // Generated protocol: parent validators parse these stdout markers for Browser Action failures.
  console.log('[makeademo:action]', JSON.stringify(removeUndefinedValues({
    elapsedMs: elapsedMs(input.sdk),
    event: 'started',
    label: input.label,
    sceneId: input.sceneId,
    timeoutMs: input.timeoutMs,
  })));
  try {
    const result = await input.callback();
    console.log('[makeademo:action]', JSON.stringify(removeUndefinedValues({
      elapsedMs: elapsedMs(input.sdk),
      event: 'succeeded',
      label: input.label,
      sceneId: input.sceneId,
      timeoutMs: input.timeoutMs,
    })));
    return result;
  } catch (error) {
    console.log('[makeademo:action]', JSON.stringify(removeUndefinedValues({
      elapsedMs: elapsedMs(input.sdk),
      event: 'failed',
      label: input.label,
      message: error instanceof Error ? error.message : String(error),
      sceneId: input.sceneId,
      timeoutMs: input.timeoutMs,
    })));
    throw error;
  }
}

function withTimeoutOptions(args, timeoutMs) {
  if (timeoutMs === undefined) {
    return args;
  }

  const nextArgs = [...args];
  const last = nextArgs.at(-1);
  if (isPlainObject(last)) {
    nextArgs[nextArgs.length - 1] = { ...last, timeout: last.timeout ?? timeoutMs };
    return nextArgs;
  }

  return [...nextArgs, { timeout: timeoutMs }];
}

function withPageActionTimeoutOptions(property, args, timeoutMs) {
  if (property === 'waitForLoadState') {
    return withTimeoutAtOptionsIndex(args, timeoutMs, 1);
  }
  if (property === 'selectOption') {
    return withTimeoutAtOptionsIndex(args, timeoutMs, 2);
  }
  if (property === 'waitForFunction') {
    return withTimeoutAtOptionsIndex(args, timeoutMs, 2);
  }
  return withTimeoutOptions(args, timeoutMs);
}

function withLocatorActionTimeoutOptions(property, args, timeoutMs) {
  if (property === 'selectOption') {
    return withTimeoutAtOptionsIndex(args, timeoutMs, 1);
  }
  return withTimeoutOptions(args, timeoutMs);
}

function withTimeoutAtOptionsIndex(args, timeoutMs, optionsIndex) {
  if (timeoutMs === undefined) {
    return args;
  }

  const nextArgs = [...args];
  while (nextArgs.length < optionsIndex) {
    nextArgs.push(undefined);
  }
  const existingOptions = nextArgs[optionsIndex];
  nextArgs[optionsIndex] = isPlainObject(existingOptions)
    ? { ...existingOptions, timeout: existingOptions.timeout ?? timeoutMs }
    : { timeout: timeoutMs };
  return nextArgs;
}

function runBoundedWaitForTimeout(waitForTimeout, target, args, timeoutMs) {
  const requestedTimeoutMs = Number(args[0] ?? 0);
  if (
    timeoutMs !== undefined &&
    Number.isFinite(requestedTimeoutMs) &&
    requestedTimeoutMs > timeoutMs
  ) {
    throw new Error(
      \`page.waitForTimeout requested \${requestedTimeoutMs}ms, above the MakeADemo validation action timeout of \${timeoutMs}ms.\`,
    );
  }

  return waitForTimeout.apply(target, args);
}

function describeAssertionSubject(actual) {
  if (actual && typeof actual === 'object' && typeof actual.__makeademoDescription === 'string') {
    return actual.__makeademoDescription;
  }

  return 'subject';
}

function formatActionArguments(args) {
  return args
    .filter((arg) => !isPlainObject(arg))
    .map((arg) => {
      if (typeof arg === 'string') {
        return arg;
      }
      if (typeof arg === 'number' || typeof arg === 'boolean') {
        return String(arg);
      }
      if (arg === null) {
        return 'null';
      }
      if (Array.isArray(arg)) {
        return JSON.stringify(arg);
      }
      return typeof arg;
    })
    .join(', ');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function removeUndefinedValues(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}
`;
}

function declarationSource() {
  return `import type { expect as playwrightExpect, Locator, Page } from '@playwright/test';

export type MakeADemoSceneContext = {
  baseUrl: string;
  expect: typeof playwrightExpect;
  page: Page;
};

export declare function setup(
  callback: (context: MakeADemoSceneContext) => Promise<void> | void,
): Promise<void>;

export declare function scene(
  id: string,
  callback: (context: MakeADemoSceneContext) => Promise<void> | void,
): Promise<void>;

/** Executes one compiler-identified Browser Action inside the active setup or Scene scope. */
export declare function step<Result>(
  id: string,
  callback: () => Promise<Result> | Result,
): Promise<Result>;

// Humanized interaction helpers are provided by the capture wrapper at
// execution time; compiled Demo Scripts reference them as globals.
declare global {
  function animatedClick(page: Page, locator: Locator): Promise<void>;
  function animatedHover(page: Page, locator: Locator): Promise<void>;
  function animatedScrollTo(
    page: Page,
    locator: Locator,
    position: 'bottom' | 'top',
  ): Promise<void>;
  function humanType(
    page: Page,
    locator: Locator,
    text: string,
  ): Promise<void>;
}
`;
}

function instructionsSource() {
  return `# MakeADemo Capture SDK Contract

Import setup, scene, and step from './makeademo-capture-sdk'. Authentication prerequisites are owned by the prepared runtime. Put grounded off-camera navigation and seeded UI setup in setup. Put each on-camera product moment in scene(id, async ({ page, baseUrl, expect }) => { ... }). Wrap every compiler-identified Browser Action in step(actionId, async () => { ... }) so failures retain their durable Action ID. Each scene must prove a visible outcome with Playwright toBeVisible or toBeInViewport before it ends; text, URL, title, and count assertions may supplement but cannot replace that visibility proof.

Do not launch browsers, create contexts, configure recordVideo, write marker logs, print [makeademo:scene] lines, or provide timestamps/durations.

Do not use real-time network access from the Demo Script. Do not call fetch, XMLHttpRequest, WebSocket, EventSource, navigator.sendBeacon, page.waitForRequest, page.waitForResponse, page.route, page.unroute, or Node network modules.

Do not import any module other than './makeademo-capture-sdk'. Do not use require, dynamic import, process, Bun, Deno, eval, or Function. Capture Scripts may only use the Capture SDK context and Playwright page/locator APIs.

Do not bypass the prepared app UI with app-internal JavaScript such as page.evaluate, page.addScriptTag, page.addInitScript, page.exposeFunction, or page.exposeBinding. Demo Scripts must use user-visible navigation, interactions, and locator assertions against the prepared app.
`;
}
