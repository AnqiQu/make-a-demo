import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAuthClient } from "../../../../src/adapters/codex/auth/CodexAuthClient";
import { JsonFileTokenStore } from "../../../../src/adapters/file-system/JsonFileTokenStore";

test("Codex auth client lazily refreshes tokens that are near expiry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-refresh-"));
  const store = new JsonFileTokenStore({
    filePath: join(cwd, ".agent", "auth.json"),
  });
  await store.write({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: Date.now() + 100,
    account: null,
  });

  const fetchCalls: RequestInfo[] = [];
  const client = new CodexAuthClient({
    tokenStore: store,
    fetch: async (input) => {
      fetchCalls.push(input);
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    },
  });

  await expect(client.getAccessToken()).resolves.toBe("new-access");
  await expect(store.read()).resolves.toMatchObject({
    accessToken: "new-access",
    refreshToken: "new-refresh",
  });
  expect(String(fetchCalls[0])).toBe("https://auth.openai.com/oauth/token");
});

test("Codex auth client exchanges OAuth authorization codes into local tokens", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-exchange-"));
  const store = new JsonFileTokenStore({
    filePath: join(cwd, ".agent", "auth.json"),
  });
  const client = new CodexAuthClient({
    tokenStore: store,
    fetch: async () =>
      new Response(
        JSON.stringify({
          access_token: "access-from-code",
          refresh_token: "refresh-from-code",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
  });

  await client.exchangeAuthorizationCode({
    code: "oauth-code",
    redirectUri: "http://localhost:1455/auth/callback",
    codeVerifier: "verifier",
  });

  await expect(store.read()).resolves.toMatchObject({
    accessToken: "access-from-code",
    refreshToken: "refresh-from-code",
    account: null,
  });
});
