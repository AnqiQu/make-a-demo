export type GitHubRepository = {
  fullName: string;
  private: boolean;
  repoUrl: string;
};

export type GitHubRepositoryListDependencies = {
  createInstallationToken(installationId: string): Promise<string>;
  fetchJson(
    url: string,
    init: { headers: Record<string, string> },
  ): Promise<unknown>;
};

type GitHubAppEnvironment = {
  appId: string;
  appSlug: string;
  privateKey: string;
  redirectUrl: string;
};

type GitHubApiRepository = {
  full_name?: unknown;
  html_url?: unknown;
  private?: unknown;
};

export function createGitHubInstallUrl(input: {
  appSlug: string;
  redirectUrl: string;
  state: string;
}): string {
  const params = new URLSearchParams();
  params.set("state", input.state);
  params.set("redirect_uri", input.redirectUrl);

  return `https://github.com/apps/${input.appSlug}/installations/select_target?${params.toString()}`;
}

export async function listGitHubInstallationRepositories(
  input: { installationId: string },
  dependencies: GitHubRepositoryListDependencies,
): Promise<GitHubRepository[]> {
  const token = await dependencies.createInstallationToken(
    input.installationId,
  );
  const response = await dependencies.fetchJson(
    "https://api.github.com/installation/repositories",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  const repositories = readRepositories(response);

  return repositories.map((repository) => ({
    fullName: repository.full_name,
    private: repository.private,
    repoUrl: repository.html_url,
  }));
}

export function createGitHubAppIntegrationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
) {
  const app = readGitHubAppEnvironment(env);

  return {
    createInstallUrl(input: { state: string }) {
      return createGitHubInstallUrl({
        appSlug: app.appSlug,
        redirectUrl: app.redirectUrl,
        state: input.state,
      });
    },
    listRepositories(installationId: string) {
      return listGitHubInstallationRepositories(
        { installationId },
        {
          createInstallationToken: (id) => createInstallationToken(id, app),
          fetchJson,
        },
      );
    },
  };
}

async function createInstallationToken(
  installationId: string,
  app: GitHubAppEnvironment,
): Promise<string> {
  const jwt = createGitHubAppJwt(app);
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub installation token request failed: ${response.status}`,
    );
  }

  const body = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as { token?: unknown }).token !== "string"
  ) {
    throw new Error("GitHub installation token response is missing token");
  }

  return (body as { token: string }).token;
}

function createGitHubAppJwt(app: GitHubAppEnvironment): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      exp: now + 60 * 10,
      iat: now - 60,
      iss: app.appId,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(normalizePrivateKey(app.privateKey));

  return `${unsigned}.${base64Url(signature)}`;
}

async function fetchJson(
  url: string,
  init: { headers: Record<string, string> },
) {
  const response = await fetch(url, { headers: init.headers });
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status}`);
  }

  return response.json();
}

function readGitHubAppEnvironment(
  env: NodeJS.ProcessEnv,
): GitHubAppEnvironment {
  const appId = readRequiredEnv(env, "GITHUB_APP_ID");
  const appSlug = readRequiredEnv(env, "GITHUB_APP_SLUG");
  const privateKey = readRequiredEnv(env, "GITHUB_PRIVATE_KEY");
  const redirectUrl =
    env.GITHUB_REDIRECT_URL ?? "http://localhost:5173/github/callback";

  return { appId, appSlug, privateKey, redirectUrl };
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function normalizePrivateKey(privateKey: string) {
  return privateKey.replaceAll("\\n", "\n");
}

function base64Url(value: Buffer | string) {
  const buffer = typeof value === "string" ? Buffer.from(value) : value;

  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function readRepositories(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub repository response must be an object");
  }

  const repositories = (value as { repositories?: unknown }).repositories;
  if (!Array.isArray(repositories)) {
    throw new Error("GitHub repository response must include repositories");
  }

  return repositories.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`repositories[${index}] must be an object`);
    }

    const repository = item as GitHubApiRepository;
    if (
      typeof repository.full_name !== "string" ||
      typeof repository.html_url !== "string" ||
      typeof repository.private !== "boolean"
    ) {
      throw new Error(`repositories[${index}] is missing required fields`);
    }

    return {
      full_name: repository.full_name,
      html_url: repository.html_url,
      private: repository.private,
    };
  });
}
import { createSign } from "node:crypto";
