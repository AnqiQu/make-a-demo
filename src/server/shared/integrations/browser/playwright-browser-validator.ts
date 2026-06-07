import type {
  BrowserValidationInput,
  BrowserValidationOutput,
  BrowserValidator,
} from "../../../pipeline/02-project-validation/browser-validator.interface";

export class PlaywrightBrowserValidator implements BrowserValidator {
  async validate(
    _input: BrowserValidationInput,
  ): Promise<BrowserValidationOutput> {
    // TODO: Run Playwright inside the sandbox and return page-load/interactability artifacts.
    throw new Error(
      "PlaywrightBrowserValidator is a stub until browser validation is implemented.",
    );
  }
}
