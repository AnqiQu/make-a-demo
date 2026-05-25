import { spawn } from "node:child_process";

import type { OAuthFlow } from "../../core/auth/OAuthFlow.interface";
import type { TokenStore } from "../../core/auth/TokenStore.interface";

interface EnsureRuntimeAuthOptions {
  readonly tokenStore: TokenStore;
  readonly oauthFlow: OAuthFlow;
  readonly exchangeAuthorizationCode: (input: {
    readonly authorizationCode: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
  }) => Promise<unknown>;
  readonly headless: boolean;
  readonly output: (line: string) => void;
  readonly openUrl?: (url: string) => Promise<void>;
}

/** Ensures the runtime has local auth, starting OAuth when no token exists. */
export async function ensureRuntimeAuth(
  options: EnsureRuntimeAuthOptions,
): Promise<void> {
  const existing = await options.tokenStore.read();
  if (existing) {
    return;
  }

  options.output("No local Codex login found. Starting OAuth login.");
  const login = await options.oauthFlow.start();
  options.output(`Open this URL to authorize the agent:\n${login.authUrl}`);

  if (!options.headless) {
    await (options.openUrl ?? openBrowser)(login.authUrl);
  }

  const authorizationCode = await login.waitForCode();
  await options.exchangeAuthorizationCode({
    authorizationCode,
    redirectUri: login.redirectUri,
    codeVerifier: login.codeVerifier,
  });
  options.output("Codex login saved locally.");
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const commandArgs =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, commandArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
