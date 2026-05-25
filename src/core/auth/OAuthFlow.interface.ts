/**
 * Active OAuth login attempt.
 * Implementations must keep the verifier paired with the auth URL, resolve
 * `waitForCode` once with the callback code, and make `cancel` idempotent.
 */
export interface OAuthLogin {
  readonly authUrl: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly waitForCode: () => Promise<string>;
  readonly cancel: () => Promise<void>;
}

/** Starts an OAuth login attempt for a provider-specific auth adapter. */
export interface OAuthFlow {
  /** Starts the login flow and returns the active login attempt. */
  readonly start: () => Promise<OAuthLogin>;
}
