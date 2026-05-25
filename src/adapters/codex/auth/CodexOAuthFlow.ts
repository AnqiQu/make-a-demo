import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Server, createServer } from "node:http";

import type {
  OAuthFlow,
  OAuthLogin,
} from "../../../core/auth/OAuthFlow.interface";

const OPENAI_AUTH_ISSUER = "https://auth.openai.com";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/**
 * Active Codex OAuth login attempt.
 * Implementations must keep the verifier paired with the generated auth URL,
 * resolve `waitForCode` once with the callback code, and make `cancel`
 * idempotently release any local listener resources.
 */
export interface CodexOAuthLogin extends OAuthLogin {
  readonly loginId: string;
}

/**
 * Local callback settings for Codex OAuth.
 * Implementations must use these values only to configure the local listener;
 * omitted fields should fall back to safe defaults for local development.
 */
export interface CodexOAuthFlowOptions {
  readonly callbackHost?: string;
  readonly callbackPort?: number;
  readonly loginTimeoutMs?: number;
}

/** Starts the local callback listener used by both browser and headless URL auth. */
export class CodexOAuthFlow implements OAuthFlow {
  readonly #callbackHost: string;
  readonly #callbackPort: number;
  readonly #loginTimeoutMs: number;

  constructor(options: CodexOAuthFlowOptions = {}) {
    this.#callbackHost = options.callbackHost ?? "localhost";
    this.#callbackPort = options.callbackPort ?? 1455;
    this.#loginTimeoutMs = options.loginTimeoutMs ?? 5 * 60_000;
  }

  async start(): Promise<CodexOAuthLogin> {
    const loginId = randomUUID();
    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const state = randomBytes(32).toString("base64url");
    let server: Server | null = null;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let finish:
      | ((result: { readonly code?: string; readonly error?: string }) => void)
      | null = null;

    const completion = new Promise<string>((resolve, reject) => {
      finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        void new Promise<void>((done) => server?.close(() => done()));
        if (result.error) {
          reject(new Error(result.error));
          return;
        }
        resolve(result.code ?? "");
      };
      timeout = setTimeout(
        () => finish?.({ error: "OAuth login timed out." }),
        this.#loginTimeoutMs,
      );
    });

    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${this.#callbackHost}`);
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error =
        url.searchParams.get("error_description") ??
        url.searchParams.get("error");
      response.writeHead(error ? 400 : 200, { "Content-Type": "text/html" });
      response.end(
        error
          ? "Authorization failed."
          : "Authorization complete. You can close this window.",
      );
      if (error) {
        finish?.({ error });
        return;
      }
      if (returnedState !== state) {
        finish?.({ error: "Invalid OAuth state." });
        return;
      }
      finish?.(code ? { code } : { error: "Missing authorization code." });
    });

    await new Promise<void>((resolve, reject) => {
      server?.listen(this.#callbackPort, this.#callbackHost, () => resolve());
      server?.once("error", reject);
    });

    const address = server.address();
    const port =
      typeof address === "object" && address
        ? address.port
        : this.#callbackPort;
    const redirectUri = `http://${this.#callbackHost}:${port}/auth/callback`;
    const authUrl = `${OPENAI_AUTH_ISSUER}/oauth/authorize?${new URLSearchParams(
      {
        response_type: "code",
        client_id: CODEX_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: "openid profile email offline_access",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        state,
      },
    ).toString()}`;

    return {
      loginId,
      authUrl,
      redirectUri,
      codeVerifier,
      waitForCode: () => completion,
      cancel: async () => {
        finish?.({ error: "Login cancelled." });
      },
    };
  }
}
