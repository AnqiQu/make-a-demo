import type {
  CodexTokenRecord,
  TokenStore,
} from "../../../core/auth/TokenStore.interface";
import { AgentError } from "../../../core/errors/AgentError";

const OPENAI_AUTH_ISSUER = "https://auth.openai.com";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_SAFETY_MARGIN_MS = 60_000;

interface CodexRefreshResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
}

interface CodexTokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in?: number;
}

interface CodexAuthClientOptions {
  readonly tokenStore: TokenStore;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Reads local subscription auth and refreshes access tokens lazily before model calls. */
export class CodexAuthClient {
  readonly #tokenStore: TokenStore;
  readonly #fetch: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(options: CodexAuthClientOptions) {
    this.#tokenStore = options.tokenStore;
    this.#fetch = options.fetch ?? fetch;
  }

  async getAccessToken(): Promise<string> {
    const record = await this.#tokenStore.read();
    if (!record) {
      throw new AgentError({
        code: "auth_missing",
        message:
          "No local Codex auth token exists. Start an OAuth login first.",
      });
    }

    if (record.expiresAt > Date.now() + REFRESH_SAFETY_MARGIN_MS) {
      return record.accessToken;
    }

    return (await this.#refresh(record)).accessToken;
  }

  /** Exchanges a completed local OAuth login for persisted subscription tokens. */
  async exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
  }): Promise<CodexTokenRecord> {
    const response = await this.#fetch(`${OPENAI_AUTH_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: CODEX_CLIENT_ID,
        code_verifier: input.codeVerifier,
      }).toString(),
    });

    if (!response.ok) {
      throw new AgentError({
        code: "auth_failed",
        message: `Codex OAuth exchange failed with status ${response.status}.`,
      });
    }

    const body = (await response.json()) as CodexTokenResponse;
    const record: CodexTokenRecord = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      account: null,
    };
    await this.#tokenStore.write(record);
    return record;
  }

  async #refresh(record: CodexTokenRecord): Promise<CodexTokenRecord> {
    const response = await this.#fetch(`${OPENAI_AUTH_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: record.refreshToken,
        client_id: CODEX_CLIENT_ID,
      }).toString(),
    });

    if (!response.ok) {
      throw new AgentError({
        code: "auth_failed",
        message: `Codex token refresh failed with status ${response.status}.`,
      });
    }

    const body = (await response.json()) as CodexRefreshResponse;
    const next: CodexTokenRecord = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? record.refreshToken,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      account: record.account,
    };
    await this.#tokenStore.write(next);
    return next;
  }
}
