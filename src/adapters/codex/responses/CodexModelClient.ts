import { AgentError } from "../../../core/errors/AgentError";
import type {
  ModelClient,
  ModelRequest,
  ModelStreamEvent,
} from "../../../core/model/ModelClient.interface";
import {
  mapCodexResponsesEvent,
  parseSseDataMessages,
} from "./responsesEvents";
import { buildCodexResponsesBody } from "./responsesRequest";

const CODEX_RESPONSES_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/responses";

interface CodexModelClientOptions {
  readonly getAccessToken: () => Promise<string>;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Direct model client for the Codex subscription Responses endpoint. */
export class CodexModelClient implements ModelClient {
  readonly #getAccessToken: () => Promise<string>;
  readonly #fetch: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(options: CodexModelClientOptions) {
    this.#getAccessToken = options.getAccessToken;
    this.#fetch = options.fetch ?? fetch;
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const accessToken = await this.#getAccessToken();
    const httpResponse = await this.#fetch(CODEX_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildCodexResponsesBody(request)),
    });

    if (!httpResponse.ok) {
      const errorBody = await httpResponse.text().catch(() => "");
      throw new AgentError({
        code: "transport_failed",
        message: `Codex Responses request failed with status ${httpResponse.status}.${errorBody ? ` ${errorBody}` : ""}`,
        retryable: httpResponse.status >= 500,
      });
    }

    if (!httpResponse.body) {
      throw new AgentError({
        code: "transport_failed",
        message: "Codex Responses request did not include a stream body.",
      });
    }

    for await (const sseMessage of parseSseDataMessages(httpResponse.body)) {
      const modelEvent = mapCodexResponsesEvent(JSON.parse(sseMessage.data));
      if (modelEvent) {
        yield modelEvent;
      }
    }
  }
}
