import { createOpencode } from "@opencode-ai/sdk";

import type {
  RepoPreparationAgent,
  RepoPreparationInput,
} from "../../../pipeline/03-repo-preparation/repo-preparation-agent.interface";

type OpenCodeClient = {
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

export type OpenCodeRepoPreparationAgentOptions = {
  client?: OpenCodeClient;
  directory?: string;
  modelID: string;
  providerID: string;
};

export class OpenCodeRepoPreparationAgent implements RepoPreparationAgent {
  private readonly client: OpenCodeClient;
  private readonly modelID: string;
  private readonly providerID: string;

  constructor(options: OpenCodeRepoPreparationAgentOptions) {
    this.client = options.client ?? createSdkBackedClient(options.directory);
    this.modelID = options.modelID;
    this.providerID = options.providerID;
  }

  async prepare(input: RepoPreparationInput) {
    const session = await this.client.session.create();
    const response = await this.client.session.chat(session.id, {
      modelID: this.modelID,
      parts: [{ text: createRepoPreparationPrompt(input), type: "text" }],
      providerID: this.providerID,
      system: repoPreparationSystemPrompt,
      tools: {
        edit: true,
        read: true,
        search: true,
      },
    });

    const messages = await this.client.session.messages(session.id);
    return parseAgentResult(messages, response.id);
  }
}

function createSdkBackedClient(directory?: string): OpenCodeClient {
  let clientPromise: Promise<OpenCodeClient> | undefined;

  async function getClient() {
    clientPromise ??= createOpencode().then(({ client }) => ({
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
            ...(directory === undefined ? {} : { query: { directory } }),
          });
          if (!response.data) {
            throw new Error("OpenCode did not return a prompt response.");
          }

          return { id: response.data.info.id };
        },
        async create() {
          const response = await client.session.create(
            directory === undefined ? undefined : { query: { directory } },
          );
          if (!response.data) {
            throw new Error("OpenCode did not create a session.");
          }

          return { id: response.data.id };
        },
        async messages(id) {
          const response = await client.session.messages({
            path: { id },
            ...(directory === undefined ? {} : { query: { directory } }),
          });

          return response.data ?? [];
        },
      },
    }));

    return clientPromise;
  }

  return {
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
  };
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
