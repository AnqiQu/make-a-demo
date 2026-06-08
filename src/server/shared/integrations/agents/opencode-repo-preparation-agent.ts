import { createOpencode } from "@opencode-ai/sdk";
import { createOpencodeClient } from "@opencode-ai/sdk/client";

import type {
  RepoPreparationAgent,
  RepoPreparationInput,
} from "../../../pipeline/03-repo-preparation/repo-preparation-agent.interface";
import { createDockerizedOpencodeServer } from "./dockerized-opencode-server";

type OpenCodeClient = {
  close?(): Promise<void> | void;
  events?(
    signal: AbortSignal,
  ): AsyncIterable<OpenCodeEvent> | Promise<AsyncIterable<OpenCodeEvent>>;
  session: {
    chat(
      id: string,
      body: {
        modelID: string;
        parts: Array<{ text: string; type: "text" }>;
        providerID: string;
        system?: string;
        tools?: Record<string, boolean>;
      },
    ): Promise<{ id: string }>;
    create(): Promise<{ id: string }>;
    messages(id: string): Promise<OpenCodeMessage[]>;
  };
};

type OpenCodeMessage = {
  info?: {
    id?: string;
    role?: string;
  };
  parts?: Array<{
    text?: string;
    type?: string;
  }>;
};

type OpenCodeEvent = {
  properties?: {
    file?: string;
    part?: {
      delta?: string;
      sessionID?: string;
      state?: {
        error?: string;
        status?: string;
        title?: string;
      };
      text?: string;
      tool?: string;
      type?: string;
    };
    sessionID?: string;
    status?: { type?: string };
  };
  type?: string;
};

export type OpenCodeRepoPreparationAgentOptions = {
  client?: OpenCodeClient;
  directory?: string;
  isolateWithDocker?: boolean;
  modelID: string;
  onProgress?: (line: string) => void;
  providerID: string;
};

export class OpenCodeRepoPreparationAgent implements RepoPreparationAgent {
  private readonly client: OpenCodeClient;
  private readonly modelID: string;
  private readonly onProgress: ((line: string) => void) | undefined;
  private readonly providerID: string;

  constructor(options: OpenCodeRepoPreparationAgentOptions) {
    this.client =
      options.client ??
      createSdkBackedClient({
        directory: options.directory,
        isolateWithDocker: options.isolateWithDocker ?? true,
      });
    this.modelID = options.modelID;
    this.onProgress = options.onProgress;
    this.providerID = options.providerID;
  }

  async prepare(input: RepoPreparationInput) {
    let progressAbort: AbortController | undefined;
    let progressPromise: Promise<void> | undefined;

    try {
      const session = await this.client.session.create();
      if (this.onProgress !== undefined && this.client.events !== undefined) {
        progressAbort = new AbortController();
        progressPromise = streamOpenCodeProgress({
          client: this.client,
          onProgress: this.onProgress,
          sessionId: session.id,
          signal: progressAbort.signal,
        });
      }

      const response = await this.client.session
        .chat(session.id, {
          modelID: this.modelID,
          parts: [{ text: createRepoPreparationPrompt(input), type: "text" }],
          providerID: this.providerID,
          system: repoPreparationSystemPrompt,
          tools: {
            bash: true,
            edit: true,
            question: false,
            read: true,
            search: true,
            webfetch: true,
          },
        })
        .catch((error: unknown) => {
          throw new OpenCodePromptError(error);
        });

      const messages = await this.client.session.messages(session.id);
      return parseAgentResult(messages, response.id);
    } catch (error) {
      if (error instanceof OpenCodePromptError) {
        return {
          assumptions: [],
          blockers: [`OpenCode prompt failed: ${error.reason}`],
          status: "failed" as const,
          suggestedChanges: [
            "Retry repo preparation after fixing the OpenCode provider, model, or server configuration.",
          ],
        };
      }

      throw error;
    } finally {
      progressAbort?.abort();
      await progressPromise;
      await this.client.close?.();
    }
  }
}

class OpenCodePromptError extends Error {
  readonly reason: string;

  constructor(error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    super(`OpenCode prompt failed: ${reason}`);
    this.reason = reason;
  }
}

async function streamOpenCodeProgress(input: {
  client: OpenCodeClient;
  onProgress: (line: string) => void;
  sessionId: string;
  signal: AbortSignal;
}) {
  try {
    const events = await input.client.events?.(input.signal);
    if (events === undefined) {
      return;
    }

    for await (const event of events) {
      if (input.signal.aborted) {
        return;
      }

      const line = formatOpenCodeProgressEvent(event, input.sessionId);
      if (line !== undefined) {
        input.onProgress(line);
      }
    }
  } catch (error) {
    if (!input.signal.aborted) {
      input.onProgress(`[opencode] progress stream failed: ${String(error)}`);
    }
  }
}

function formatOpenCodeProgressEvent(
  event: OpenCodeEvent,
  sessionId: string,
): string | undefined {
  const part = event.properties?.part;

  if (part?.sessionID !== undefined && part.sessionID !== sessionId) {
    return undefined;
  }

  if (event.type === "message.part.updated" && part?.type === "text") {
    const text = part.delta ?? part.text;
    return text === undefined || text.trim() === ""
      ? undefined
      : `[opencode] ${text.trim()}`;
  }

  if (event.type === "message.part.updated" && part?.type === "tool") {
    const status = part.state?.status;
    const title = part.state?.title ?? part.tool;
    if (title === undefined || status === undefined) {
      return undefined;
    }

    if (status === "running") {
      return `[opencode] ${part.tool ?? "tool"}: ${title}`;
    }

    if (status === "completed") {
      return `[opencode] ${part.tool ?? "tool"} completed: ${title}`;
    }

    if (status === "error") {
      return `[opencode] ${part.tool ?? "tool"} failed: ${part.state?.error ?? title}`;
    }
  }

  if (event.type === "file.edited" && event.properties?.file !== undefined) {
    return `[opencode] edited ${event.properties.file}`;
  }

  if (
    event.type === "session.status" &&
    event.properties?.sessionID === sessionId &&
    event.properties.status?.type !== undefined
  ) {
    return `[opencode] session ${event.properties.status.type}`;
  }

  return undefined;
}

function createSdkBackedClient(options: {
  directory?: string | undefined;
  isolateWithDocker: boolean;
}): OpenCodeClient {
  let clientPromise: Promise<OpenCodeClient> | undefined;
  const sessionDirectory = resolveOpenCodeSessionDirectory(options);

  async function getClient() {
    clientPromise ??= createOpenCodeClient(options).then(
      ({ client, close }) => ({
        close,
        async events(signal) {
          const response = await client.event.subscribe({ signal });
          return response.stream as AsyncIterable<OpenCodeEvent>;
        },
        session: {
          async chat(id, body) {
            const promptBody = {
              model: {
                modelID: body.modelID,
                providerID: body.providerID,
              },
              parts: body.parts,
              ...(body.system === undefined ? {} : { system: body.system }),
              ...(body.tools === undefined ? {} : { tools: body.tools }),
            };
            const response = await client.session.prompt({
              body: promptBody,
              path: { id },
              ...(sessionDirectory === undefined
                ? {}
                : { query: { directory: sessionDirectory } }),
            });
            if (!response.data) {
              throw new Error(
                `OpenCode did not return a prompt response${formatOpenCodeResponseFailure(response)}.`,
              );
            }

            return { id: response.data.info.id };
          },
          async create() {
            const response = await client.session.create(
              sessionDirectory === undefined
                ? undefined
                : { query: { directory: sessionDirectory } },
            );
            if (!response.data) {
              throw new Error("OpenCode did not create a session.");
            }

            return { id: response.data.id };
          },
          async messages(id) {
            const response = await client.session.messages({
              path: { id },
              ...(sessionDirectory === undefined
                ? {}
                : { query: { directory: sessionDirectory } }),
            });

            return response.data ?? [];
          },
        },
      }),
    );

    return clientPromise;
  }

  return {
    async events(signal) {
      const client = await getClient();
      return client.events?.(signal) ?? emptyOpenCodeEvents();
    },
    session: {
      async chat(id, body) {
        const client = await getClient();
        return client.session.chat(id, body);
      },
      async create() {
        const client = await getClient();
        return client.session.create();
      },
      async messages(id) {
        const client = await getClient();
        return client.session.messages(id);
      },
    },
    async close() {
      const client = await clientPromise;
      await client?.close?.();
      clientPromise = undefined;
    },
  };
}

async function* emptyOpenCodeEvents(): AsyncIterable<OpenCodeEvent> {}

export function resolveOpenCodeSessionDirectory(options: {
  directory?: string | undefined;
  isolateWithDocker: boolean;
}): string | undefined {
  if (options.directory === undefined) {
    return undefined;
  }

  return options.isolateWithDocker ? "/workspace" : options.directory;
}

function formatOpenCodeResponseFailure(response: unknown): string {
  if (typeof response !== "object" || response === null) {
    return "";
  }

  const record = response as Record<string, unknown>;
  const details = [
    formatResponseStatus(record.response),
    formatResponseError(record.error),
  ].filter((detail) => detail !== undefined);

  return details.length === 0 ? "" : `: ${details.join(": ")}`;
}

function formatResponseStatus(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) {
    return undefined;
  }

  const record = response as Record<string, unknown>;
  const status = record.status;
  const statusText = record.statusText;

  if (typeof status === "number" && typeof statusText === "string") {
    return `${status} ${statusText}`;
  }

  if (typeof status === "number") {
    return String(status);
  }

  return undefined;
}

function formatResponseError(error: unknown): string | undefined {
  if (error === undefined) {
    return undefined;
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.message;
    }
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function createOpenCodeClient(options: {
  directory?: string | undefined;
  isolateWithDocker: boolean;
}) {
  if (!options.isolateWithDocker || options.directory === undefined) {
    const { client, server } = await createOpencode();
    return { client, close: () => server.close() };
  }

  const server = await createDockerizedOpencodeServer({
    workspaceDirectory: options.directory,
  });
  const client = createOpencodeClient({ baseUrl: server.url });

  return { client, close: () => server.close() };
}

const repoPreparationSystemPrompt = [
  "You are MakeADemo's Repo Preparation agent.",
  "Work only in the ephemeral cloned workspace. Never modify the maker's source repo.",
  "First look for existing demo setup before creating anything new.",
  "Prepare a deterministic browser-accessible demo runtime for a JavaScript/TypeScript web app.",
  "Use local fixtures, mocks, or seeds instead of secrets, hosted services, OAuth, external APIs, or runtime network access.",
  "Use the runtime network lockdown tool/check before returning success; any external runtime request must be mocked or removed and retried.",
  'Return only JSON matching either {"status":"succeeded","manifest":...} or {"status":"failed","blockers":[],"assumptions":[],"suggestedChanges":[]}.',
].join("\n");

function createRepoPreparationPrompt(input: RepoPreparationInput): string {
  return JSON.stringify(
    {
      instructions: [
        "Prepare this repo for MakeADemo in the ephemeral workspace.",
        "Discover existing demo setup before creating new setup.",
        "Use runtime network lockdown iteratively until the app runtime is offline after setup.",
        "Return the durable Preparation Manifest or a structured preparation failure.",
        "When running in Docker, the only mounted repo workspace is /workspace. Make all edits in /workspace and run demoCommand from /workspace.",
        "Do not prepare, edit, or return paths from /tmp/opencode/repo or any copied repo. If /workspace is not writable, return a structured failure instead of using a copy.",
        "The success JSON must be {status:'succeeded', manifest:{assumptions:string[], createdFiles:string[], demoCommand:string, diffArtifactId:string, existingDemoEvidence:string[], mockedServices:string[], modifiedFiles:string[], repoUrl:string, risks:string[], scriptGenerationContext:string[], setupSummary:string, status:'adapted-existing-demo'|'created-new-demo'|'reused-existing-demo', url:string, workspaceId:string}}.",
        "The manifest url must be a local http URL and demoCommand must be the exact command MakeADemo should run from the repo root.",
      ],
      normalizedSupportingDocuments: input.normalizedSupportingDocuments,
      repoUrl: input.repoUrl,
      structuredDemoIntent: input.structuredDemoIntent,
      workspaceId: input.workspaceId,
    },
    null,
    2,
  );
}

function parseAgentResult(
  messages: OpenCodeMessage[],
  assistantMessageId: string,
) {
  const message =
    messages.find((item) => item.info?.id === assistantMessageId) ??
    messages.find((item) => item.info?.role === "assistant");
  const text = message?.parts
    ?.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");

  if (!text) {
    return {
      assumptions: [],
      blockers: ["OpenCode did not return a text response."],
      status: "failed" as const,
      suggestedChanges: [
        "Retry repo preparation with a fresh OpenCode session.",
      ],
    };
  }

  try {
    return JSON.parse(extractJson(text)) as Awaited<
      ReturnType<RepoPreparationAgent["prepare"]>
    >;
  } catch {
    return {
      assumptions: [],
      blockers: [
        "OpenCode returned a response that was not valid preparation JSON.",
      ],
      status: "failed" as const,
      suggestedChanges: [
        "Retry repo preparation and require JSON-only output.",
      ],
    };
  }
}

function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
  return fenced?.[1] ?? text;
}
