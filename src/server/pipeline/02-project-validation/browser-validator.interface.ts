export type BrowserValidationInput = {
  url: string;
};

export type BrowserValidationOutput = {
  interactable: boolean;
  logs: string[];
  screenshotArtifactId: string;
};

/**
 * Validates browser-capturable app behavior inside the sandbox.
 * Implementations must load the configured local URL, reject blank or fatal
 * runtime states, prove basic interactability, and return screenshot proof.
 */
export interface BrowserValidator {
  validate(input: BrowserValidationInput): Promise<BrowserValidationOutput>;
}
