import { describe, expect, it } from "vitest";

import {
  createOpenCodeProviderSandboxSecrets,
  ensureOpenCodeProviderDaytonaSecret,
} from "./opencode-provider-secrets";

describe("OpenCode provider Daytona secrets", () => {
  it("maps OpenAI to the Daytona sandbox secret environment variable", () => {
    expect(
      createOpenCodeProviderSandboxSecrets({
        providerID: "openai",
        providerSecretName: "makeademo-openai",
      }),
    ).toEqual({ OPENAI_API_KEY: "makeademo-openai" });
  });

  it("creates a Daytona secret from the local OpenAI API key", async () => {
    const calls: unknown[] = [];

    const secretName = await ensureOpenCodeProviderDaytonaSecret({
      client: fakeSecretClient(calls, []),
      env: { OPENAI_API_KEY: "sk-local" },
      providerID: "openai",
    });

    expect(secretName).toBe("makeademo-openai");
    expect(calls).toEqual([
      { list: true },
      {
        create: {
          description: "MakeADemo OpenCode provider credential.",
          hosts: ["api.openai.com"],
          name: "makeademo-openai",
          value: "sk-local",
        },
      },
    ]);
  });

  it("updates the existing Daytona secret when it already exists", async () => {
    const calls: unknown[] = [];

    const secretName = await ensureOpenCodeProviderDaytonaSecret({
      client: fakeSecretClient(calls, [
        { id: "secret_123", name: "makeademo-openai" },
      ]),
      env: { OPENAI_API_KEY: "sk-rotated" },
      providerID: "openai",
    });

    expect(secretName).toBe("makeademo-openai");
    expect(calls).toEqual([
      { list: true },
      {
        update: {
          id: "secret_123",
          input: {
            description: "MakeADemo OpenCode provider credential.",
            hosts: ["api.openai.com"],
            value: "sk-rotated",
          },
        },
      },
    ]);
  });

  it("re-lists and updates when concurrent secret creation wins the race", async () => {
    const calls: unknown[] = [];

    const secretName = await ensureOpenCodeProviderDaytonaSecret({
      client: fakeSecretClient(calls, [], {
        createError: Object.assign(new Error("Secret already exists"), {
          statusCode: 409,
        }),
        secretsAfterCreateError: [
          { id: "secret_123", name: "makeademo-openai" },
        ],
      }),
      env: { OPENAI_API_KEY: "sk-raced" },
      providerID: "openai",
    });

    expect(secretName).toBe("makeademo-openai");
    expect(calls).toEqual([
      { list: true },
      {
        create: {
          description: "MakeADemo OpenCode provider credential.",
          hosts: ["api.openai.com"],
          name: "makeademo-openai",
          value: "sk-raced",
        },
      },
      { list: true },
      {
        update: {
          id: "secret_123",
          input: {
            description: "MakeADemo OpenCode provider credential.",
            hosts: ["api.openai.com"],
            value: "sk-raced",
          },
        },
      },
    ]);
  });

  it("allows overriding the generated Daytona secret name", async () => {
    const calls: unknown[] = [];

    const secretName = await ensureOpenCodeProviderDaytonaSecret({
      client: fakeSecretClient(calls, []),
      env: {
        MAKEADEMO_OPENAI_DAYTONA_SECRET_NAME: "custom-openai",
        OPENAI_API_KEY: "sk-local",
      },
      providerID: "openai",
    });

    expect(secretName).toBe("custom-openai");
    expect(calls).toEqual([
      { list: true },
      {
        create: expect.objectContaining({ name: "custom-openai" }),
      },
    ]);
  });

  it("requires the local OpenAI API key before provisioning Daytona secrets", async () => {
    await expect(
      ensureOpenCodeProviderDaytonaSecret({
        client: fakeSecretClient([], []),
        env: {},
        providerID: "openai",
      }),
    ).rejects.toThrow("OPENAI_API_KEY is required for OpenAI OpenCode runs.");
  });
});

function fakeSecretClient(
  calls: unknown[],
  secrets: Array<{ id: string; name: string }>,
  options: {
    createError?: unknown;
    secretsAfterCreateError?: Array<{ id: string; name: string }>;
  } = {},
) {
  let listCount = 0;
  return {
    secret: {
      async create(input: {
        description?: string;
        hosts?: string[];
        name: string;
        value: string;
      }) {
        calls.push({ create: input });
        if (options.createError !== undefined) {
          throw options.createError;
        }
        return { id: `secret_${input.name}`, name: input.name };
      },
      async list() {
        calls.push({ list: true });
        listCount += 1;
        if (listCount > 1 && options.secretsAfterCreateError !== undefined) {
          return options.secretsAfterCreateError;
        }
        return secrets;
      },
      async update(
        id: string,
        input: { description?: string; hosts?: string[]; value?: string },
      ) {
        calls.push({ update: { id, input } });
        return {
          id,
          name: secrets.find((secret) => secret.id === id)?.name ?? id,
        };
      },
    },
  };
}
