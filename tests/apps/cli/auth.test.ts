import { ensureRuntimeAuth } from "../../../src/apps/cli/auth";

test("CLI auth starts OAuth when no local token exists", async () => {
  let openedUrl: string | null = null;
  let exchangedAuthorizationCode: string | null = null;
  const output: string[] = [];

  await ensureRuntimeAuth({
    headless: false,
    output: (line) => output.push(line),
    tokenStore: {
      read: async () => null,
      write: async () => undefined,
      clear: async () => undefined,
    },
    oauthFlow: {
      start: async () => ({
        loginId: "login_1",
        authUrl: "https://auth.example/login",
        redirectUri: "http://localhost/callback",
        codeVerifier: "verifier",
        waitForCode: async () => "oauth-code",
        cancel: async () => undefined,
      }),
    },
    openUrl: async (url) => {
      openedUrl = url;
    },
    exchangeAuthorizationCode: async ({ authorizationCode }) => {
      exchangedAuthorizationCode = authorizationCode;
    },
  });

  expect(openedUrl).toBe("https://auth.example/login");
  expect(exchangedAuthorizationCode).toBe("oauth-code");
  expect(output.join("\n")).toContain("No local Codex login found");
});
