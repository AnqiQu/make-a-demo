import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonFileTokenStore } from "../../../src/adapters/file-system/JsonFileTokenStore";

test("file token store persists and reloads local Codex auth tokens", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-auth-"));
  const store = new JsonFileTokenStore({
    filePath: join(cwd, ".agent", "auth.json"),
  });

  await store.write({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 123,
    account: { email: "milo@example.com", planType: "plus" },
  });

  await expect(store.read()).resolves.toEqual({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 123,
    account: { email: "milo@example.com", planType: "plus" },
  });
});
