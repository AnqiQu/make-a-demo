import { chromium } from "@playwright/test";

import { executeSubmittedCode } from "../../../pipeline/03-repo-preparation/submitted-code-execution";
import type {
  BrowserValidationInput,
  BrowserValidationOutput,
  BrowserValidator,
} from "../../../pipeline/05-capture-path-validation/project-runtime-preflight/browser-validator.interface";
import type { NetworkAttempt } from "../../../pipeline/05-capture-path-validation/project-runtime-preflight/network-isolation-policy";

type BrowserValidationPage = {
  close(): Promise<void>;
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded"; timeout?: number },
  ): Promise<unknown>;
  screenshot(): Promise<string>;
  route?(
    pattern: string,
    handler: (route: BrowserValidationRoute) => Promise<void>,
  ): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  requestedUrls?(): Promise<string[]>;
};

type BrowserValidationRoute = {
  abort(errorCode?: "blockedbyclient"): Promise<void>;
  continue(): Promise<void>;
  request(): { url(): string };
};

type BrowserValidationPageFactory = () => Promise<BrowserValidationPage>;

export type PlaywrightBrowserValidatorOptions = {
  pageFactory?: BrowserValidationPageFactory;
  validationTimeoutMs?: number;
};

export class PlaywrightBrowserValidator implements BrowserValidator {
  private readonly pageFactory: BrowserValidationPageFactory;
  private readonly validationTimeoutMs: number;

  constructor(options: PlaywrightBrowserValidatorOptions = {}) {
    this.pageFactory = options.pageFactory ?? createPlaywrightPage;
    this.validationTimeoutMs = options.validationTimeoutMs ?? 30_000;
  }

  async validate(
    input: BrowserValidationInput,
  ): Promise<BrowserValidationOutput> {
    if (input.preparationWorkspace !== undefined) {
      return await this.validateInsideSubmittedCode(input);
    }

    const page = await withTimeout(
      this.pageFactory(),
      this.validationTimeoutMs,
      "Browser page creation",
    );

    try {
      return await withTimeout(
        this.validatePage(input, page),
        this.validationTimeoutMs,
        `Browser validation for ${input.url}`,
      );
    } catch (error) {
      if (error instanceof BrowserValidationTimeoutError) {
        return {
          interactable: false,
          logs: [
            `Browser validation timed out after ${this.validationTimeoutMs}ms for ${input.url}`,
          ],
          screenshotArtifactId: "",
        };
      }

      throw error;
    } finally {
      await closeQuietly(page);
    }
  }

  private async validateInsideSubmittedCode(
    input: BrowserValidationInput,
  ): Promise<BrowserValidationOutput> {
    const preparationWorkspace = input.preparationWorkspace;
    if (preparationWorkspace === undefined) {
      throw new Error(
        "Submitted-code browser validation requires a workspace.",
      );
    }

    const result = await executeSubmittedCode(
      preparationWorkspace.workspace,
      createSubmittedCodeBrowserValidationCommand(input.url),
    );
    if (result.exitCode !== 0) {
      return {
        interactable: false,
        logs: [
          `Browser validation failed inside submitted-code container for ${input.url}`,
          ...[result.stdout, result.stderr].filter(
            (output) => output.length > 0,
          ),
        ],
        screenshotArtifactId: "",
      };
    }

    const parsed = tryParseBrowserValidationOutput(result.stdout);
    if (parsed === undefined) {
      return {
        interactable: false,
        logs: [
          `Browser validation returned malformed output for ${input.url}`,
          result.stdout,
        ].filter((output) => output.length > 0),
        screenshotArtifactId: "",
      };
    }

    return parsed;
  }

  private async validatePage(
    input: BrowserValidationInput,
    page: BrowserValidationPage,
  ): Promise<BrowserValidationOutput> {
    const localHost = new URL(input.url).hostname;
    const blockedRequests: NetworkAttempt[] = [];
    await page.route?.("**/*", async (route) => {
      const blockedRequest = readForbiddenBrowserRequest(
        route.request().url(),
        localHost,
      );
      if (blockedRequest !== undefined) {
        blockedRequests.push(blockedRequest);
        await route.abort("blockedbyclient");
        return;
      }

      await route.continue();
    });

    try {
      await page.goto(input.url, {
        timeout: 15_000,
        waitUntil: "domcontentloaded",
      });
    } catch (error) {
      return {
        interactable: false,
        logs: [`Failed to load ${input.url}: ${formatError(error)}`],
        screenshotArtifactId: "",
      };
    }
    if (blockedRequests.length > 0) {
      return {
        blockedNetworkAttempts: dedupeNetworkAttempts(blockedRequests),
        interactable: false,
        logs: dedupeNetworkAttempts(blockedRequests).map(
          (request) => `Blocked forbidden browser request to ${request.host}`,
        ),
        screenshotArtifactId: "",
      };
    }
    const bodyText = (await page.textContent("body")) ?? "";
    const screenshotArtifactId = await page.screenshot();
    const interactable =
      bodyText.trim().length > 0 && !looksLikeRuntimeError(bodyText);
    const blockedNetworkAttempts = findBlockedBrowserRequests(
      input.url,
      page.requestedUrls === undefined ? [] : await page.requestedUrls(),
    );

    return {
      ...(blockedNetworkAttempts.length === 0
        ? {}
        : { blockedNetworkAttempts }),
      interactable,
      logs: [
        `Loaded ${input.url}`,
        `Captured screenshot ${screenshotArtifactId}`,
      ],
      screenshotArtifactId,
    };
  }
}

function createSubmittedCodeBrowserValidationCommand(url: string): string {
  return [
    "node -",
    shellQuote(url),
    "<<'MAKEADEMO_BROWSER_VALIDATION'",
    submittedCodeBrowserValidationScript,
    "MAKEADEMO_BROWSER_VALIDATION",
  ].join(" ");
}

const submittedCodeBrowserValidationScript = String.raw`
const targetUrl = process.argv[2];
const localHost = new URL(targetUrl).hostname;
const blockedRequests = [];
let browser;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    const host = new URL(requestUrl).hostname;
    if (host !== localHost && host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      blockedRequests.push({ direction: "outbound", host, phase: "runtime" });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.goto(targetUrl, { timeout: 15000, waitUntil: "domcontentloaded" });
  if (blockedRequests.length > 0) {
    console.log(JSON.stringify({
      blockedNetworkAttempts: blockedRequests,
      interactable: false,
      logs: blockedRequests.map((request) => "Blocked forbidden browser request to " + request.host),
      screenshotArtifactId: "",
    }));
    process.exit(0);
  }
  const bodyText = (await page.textContent("body")) ?? "";
  const screenshot = await page.screenshot({ type: "png" });
  const screenshotArtifactId = "screenshot:" + screenshot.toString("base64");
  const interactable = bodyText.trim().length > 0 && !/error|exception|stack trace|not found/i.test(bodyText);
  console.log(JSON.stringify({
    interactable,
    logs: ["Loaded " + targetUrl, "Captured screenshot " + screenshotArtifactId],
    screenshotArtifactId,
  }));
} catch (error) {
  console.log(JSON.stringify({
    interactable: false,
    logs: ["Failed to load " + targetUrl + ": " + (error instanceof Error ? error.message : String(error))],
    screenshotArtifactId: "",
  }));
} finally {
  await browser?.close();
}
`;

function tryParseBrowserValidationOutput(
  output: string,
): BrowserValidationOutput | undefined {
  try {
    const payload = JSON.parse(output.trim()) as BrowserValidationOutput;
    if (
      typeof payload === "object" &&
      payload !== null &&
      typeof payload.interactable === "boolean" &&
      Array.isArray(payload.logs) &&
      typeof payload.screenshotArtifactId === "string"
    ) {
      return payload;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

class BrowserValidationTimeoutError extends Error {}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new BrowserValidationTimeoutError(
              `${operation} timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function closeQuietly(page: BrowserValidationPage) {
  try {
    await withTimeout(page.close(), 5_000, "Browser page close");
  } catch {
    // Preserve the browser validation result that triggered cleanup.
  }
}

async function createPlaywrightPage(): Promise<BrowserValidationPage> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const requestedUrls: string[] = [];
  page.on("request", (request) => {
    requestedUrls.push(request.url());
  });

  return {
    async close() {
      await browser.close();
    },
    async goto(url, options) {
      return page.goto(url, options);
    },
    async screenshot() {
      const screenshot = await page.screenshot({ type: "png" });
      return `screenshot:${screenshot.toString("base64")}`;
    },
    async requestedUrls() {
      return requestedUrls;
    },
    async route(pattern, handler) {
      await page.route(pattern, async (route) => {
        await handler({
          abort: (errorCode) => route.abort(errorCode),
          continue: () => route.continue(),
          request: () => ({ url: () => route.request().url() }),
        });
      });
    },
    async textContent(selector) {
      return page.textContent(selector);
    },
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findBlockedBrowserRequests(
  localUrl: string,
  requestedUrls: string[],
): NetworkAttempt[] {
  const localHost = new URL(localUrl).hostname;

  return requestedUrls.flatMap((requestedUrl) => {
    const request = readForbiddenBrowserRequest(requestedUrl, localHost);
    return request === undefined ? [] : [request];
  });
}

function readForbiddenBrowserRequest(
  requestedUrl: string,
  localHost: string,
): NetworkAttempt | undefined {
  try {
    const url = new URL(requestedUrl);
    if (isAllowedRuntimeHost(url.hostname, localHost)) {
      return undefined;
    }

    return {
      direction: "outbound",
      host: url.hostname,
      phase: "runtime",
    };
  } catch {
    return undefined;
  }
}

function dedupeNetworkAttempts(attempts: NetworkAttempt[]): NetworkAttempt[] {
  const seen = new Set<string>();
  return attempts.filter((attempt) => {
    const key = `${attempt.direction}:${attempt.phase}:${attempt.host}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isAllowedRuntimeHost(host: string, localHost: string): boolean {
  return (
    host.length === 0 ||
    [localHost, "127.0.0.1", "localhost", "0.0.0.0"].includes(host)
  );
}

function looksLikeRuntimeError(text: string): boolean {
  return /Unhandled Runtime Error|Application error|Internal Server Error|Vite Error/i.test(
    text,
  );
}
