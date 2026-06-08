import type { NetworkAttempt } from "./network-isolation-policy";

export type BrowserValidationInput = {
  url: string;
};

export type BrowserValidationOutput = {
  blockedNetworkAttempts?: NetworkAttempt[];
  interactable: boolean;
  logs: string[];
  screenshotArtifactId: string;
};

/**
 * Validates browser-capturable app behavior inside the sandbox.
 * Implementations must load the configured local URL, reject blank or fatal
 * runtime states, prove basic interactability, report browser-side runtime
 * network boundary attempts, and return screenshot proof.
 */
export interface BrowserValidator {
  validate(input: BrowserValidationInput): Promise<BrowserValidationOutput>;
}
