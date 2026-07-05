import { Daytona, DaytonaConflictError } from "@daytona/sdk";

const defaultOpenAiDaytonaSecretName = "makeademo-openai";
const openAiSecretHosts = ["api.openai.com"];

type DaytonaSecret = {
  id: string;
  name: string;
};

type DaytonaSecretClient = {
  secret: {
    create(input: {
      description?: string;
      hosts?: string[];
      name: string;
      value: string;
    }): Promise<DaytonaSecret>;
    list(): Promise<DaytonaSecret[]>;
    update(
      id: string,
      input: { description?: string; hosts?: string[]; value?: string },
    ): Promise<DaytonaSecret>;
  };
};

/**
 * Returns the sandbox environment variable name expected by OpenCode providers.
 * The value must be supplied by Daytona sandbox secrets, not plaintext process env.
 */
function readOpenCodeProviderSecretEnvName(providerID: string): string {
  if (providerID === "openai") {
    return "OPENAI_API_KEY";
  }

  throw new Error(`Unsupported OpenCode provider: ${providerID}`);
}

export function createOpenCodeProviderSandboxSecrets(input: {
  providerID: string;
  providerSecretName: string;
}): Record<string, string> {
  return {
    [readOpenCodeProviderSecretEnvName(input.providerID)]:
      input.providerSecretName,
  };
}

export async function ensureOpenCodeProviderDaytonaSecret(input: {
  client?: DaytonaSecretClient;
  daytonaApiKey?: string;
  env?: Record<string, string | undefined>;
  providerID: string;
}): Promise<string> {
  const provider = readOpenCodeProviderSecret(input.providerID, input.env);
  const secretName = readOpenCodeProviderDaytonaSecretName(
    input.providerID,
    input.env,
  );
  const client =
    input.client ??
    (new Daytona(
      input.daytonaApiKey === undefined
        ? undefined
        : { apiKey: input.daytonaApiKey },
    ) as DaytonaSecretClient);

  const existingSecret = (
    await withDaytonaSecretConnectionRetry(() => client.secret.list())
  ).find((secret) => secret.name === secretName);
  const secretInput = {
    description: "MakeADemo OpenCode provider credential.",
    hosts: provider.hosts,
    value: provider.apiKey,
  };

  if (existingSecret === undefined) {
    try {
      await withDaytonaSecretConnectionRetry(() =>
        client.secret.create({
          ...secretInput,
          name: secretName,
        }),
      );
    } catch (error) {
      if (!isDaytonaSecretConflictError(error)) {
        throw error;
      }

      const racedSecret = (
        await withDaytonaSecretConnectionRetry(() => client.secret.list())
      ).find((secret) => secret.name === secretName);
      if (racedSecret === undefined) {
        throw error;
      }

      await withDaytonaSecretConnectionRetry(() =>
        client.secret.update(racedSecret.id, secretInput),
      );
    }
    return secretName;
  }

  await withDaytonaSecretConnectionRetry(() =>
    client.secret.update(existingSecret.id, secretInput),
  );
  return secretName;
}

async function withDaytonaSecretConnectionRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (
        attempt === maxAttempts ||
        !isTransientDaytonaConnectionError(error)
      ) {
        throw error;
      }
    }
  }

  throw lastError;
}

function isTransientDaytonaConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if ("code" in error && error.code === "ECONNREFUSED") {
    return true;
  }

  if ("name" in error && error.name === "DaytonaConnectionError") {
    return true;
  }

  if (
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("ECONNREFUSED")
  ) {
    return true;
  }

  if ("cause" in error) {
    return isTransientDaytonaConnectionError(error.cause);
  }

  return false;
}

function isDaytonaSecretConflictError(error: unknown): boolean {
  if (error instanceof DaytonaConflictError) {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 409
  );
}

function readOpenCodeProviderSecret(
  providerID: string,
  env: Record<string, string | undefined> = process.env,
): { apiKey: string; hosts: string[] } {
  if (providerID === "openai") {
    const apiKey = env.OPENAI_API_KEY;
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new Error("OPENAI_API_KEY is required for OpenAI OpenCode runs.");
    }

    return { apiKey, hosts: openAiSecretHosts };
  }

  throw new Error(`Unsupported OpenCode provider: ${providerID}`);
}

function readOpenCodeProviderDaytonaSecretName(
  providerID: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (providerID === "openai") {
    return (
      env.MAKEADEMO_OPENAI_DAYTONA_SECRET_NAME?.trim() ||
      defaultOpenAiDaytonaSecretName
    );
  }

  throw new Error(`Unsupported OpenCode provider: ${providerID}`);
}
