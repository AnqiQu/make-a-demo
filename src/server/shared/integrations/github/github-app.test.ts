import { describe, expect, it } from "vitest";

import {
  connectGitHubAuthorizedInstallation,
  createGitHubInstallUrl,
  listGitHubInstallationRepositories,
} from "./github-app";

describe("GitHub App integration", () => {
  it("creates the GitHub App target selection URL with the callback redirect URI", () => {
    expect(
      createGitHubInstallUrl({
        appSlug: "owlet-demo",
        redirectUrl: "https://app.example.com/github/callback",
        state: "draft-123",
      }),
    ).toBe(
      "https://github.com/apps/owlet-demo/installations/select_target?state=draft-123&redirect_uri=https%3A%2F%2Fapp.example.com%2Fgithub%2Fcallback",
    );
  });

  it("lists repositories available to an installation", async () => {
    const repositories = await listGitHubInstallationRepositories(
      { installationId: "123" },
      {
        createInstallationToken: async (installationId) => {
          expect(installationId).toBe("123");
          return "token-123";
        },
        fetchJson: async (url, init) => {
          expect(url).toBe("https://api.github.com/installation/repositories");
          expect(init.headers.Authorization).toBe("Bearer token-123");
          return {
            repositories: [
              {
                full_name: "example/private-app",
                html_url: "https://github.com/example/private-app",
                private: true,
              },
            ],
          };
        },
      },
    );

    expect(repositories).toEqual([
      {
        fullName: "example/private-app",
        private: true,
        repoUrl: "https://github.com/example/private-app",
      },
    ]);
  });

  it("uses the existing installation available to an authorized GitHub user", async () => {
    const requests: Array<{ authorization: string; url: string }> = [];
    const connection = await connectGitHubAuthorizedInstallation(
      { code: "oauth-code" },
      {
        createUserAccessToken: async (code) => {
          expect(code).toBe("oauth-code");
          return "user-token";
        },
        fetchJson: async (url, init) => {
          requests.push({
            authorization: init.headers.Authorization ?? "",
            url,
          });

          if (url === "https://api.github.com/user/installations") {
            return { installations: [{ id: 123 }] };
          }

          if (
            url === "https://api.github.com/user/installations/123/repositories"
          ) {
            return {
              repositories: [
                {
                  full_name: "example/private-app",
                  html_url: "https://github.com/example/private-app",
                  private: true,
                },
              ],
            };
          }

          throw new Error(`unexpected GitHub URL: ${url}`);
        },
      },
    );

    expect(connection).toEqual({
      installationId: "123",
      repositories: [
        {
          fullName: "example/private-app",
          private: true,
          repoUrl: "https://github.com/example/private-app",
        },
      ],
    });
    expect(requests).toEqual([
      {
        authorization: "Bearer user-token",
        url: "https://api.github.com/user/installations",
      },
      {
        authorization: "Bearer user-token",
        url: "https://api.github.com/user/installations/123/repositories",
      },
    ]);
  });

  it("returns null when an authorized GitHub user has no existing installations", async () => {
    const connection = await connectGitHubAuthorizedInstallation(
      { code: "oauth-code" },
      {
        createUserAccessToken: async () => "user-token",
        fetchJson: async () => ({ installations: [] }),
      },
    );

    expect(connection).toBeNull();
  });
});
