import { chromium } from "@playwright/test";

import type {
  BrowserValidationInput,
  BrowserValidationOutput,
  BrowserValidator,
} from "../../../pipeline/04-project-validation/browser-validator.interface";

type BrowserValidationPage = {
  close(): Promise<void>;
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded"; timeout?: number },
  ): Promise<unknown>;
  screenshot(): Promise<string>;
  textContent(selector: string): Promise<string | null>;
};

type BrowserValidationPageFactory = () => Promise<BrowserValidationPage>;

export type PlaywrightBrowserValidatorOptions = {
  pageFactory?: BrowserValidationPageFactory;
};

export class PlaywrightBrowserValidator implements BrowserValidator {
  private readonly pageFactory: BrowserValidationPageFactory;

  constructor(options: PlaywrightBrowserValidatorOptions = {}) {
    this.pageFactory = options.pageFactory ?? createPlaywrightPage;
  }

  async validate(
    input: BrowserValidationInput,
  ): Promise<BrowserValidationOutput> {
    const page = await this.pageFactory();

    try {
      await page.goto(input.url, {
        timeout: 15_000,
        waitUntil: "domcontentloaded",
      });
      const bodyText = (await page.textContent("body")) ?? "";
      const screenshotArtifactId = await page.screenshot();
      const interactable =
        bodyText.trim().length > 0 && !looksLikeRuntimeError(bodyText);

      return {
        interactable,
        logs: [
          `Loaded ${input.url}`,
          `Captured screenshot ${screenshotArtifactId}`,
        ],
        screenshotArtifactId,
      };
    } finally {
      await page.close();
    }
  }
}

async function createPlaywrightPage(): Promise<BrowserValidationPage> {
  const browser = await chromium.launch();
  const page = await browser.newPage();

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
    async textContent(selector) {
      return page.textContent(selector);
    },
  };
}

function looksLikeRuntimeError(text: string): boolean {
  return /Unhandled Runtime Error|Application error|Internal Server Error|Vite Error/i.test(
    text,
  );
}
