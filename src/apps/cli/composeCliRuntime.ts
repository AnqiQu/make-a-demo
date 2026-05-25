import { join } from "node:path";

import { CodexAuthClient } from "../../adapters/codex/auth/CodexAuthClient";
import { CodexOAuthFlow } from "../../adapters/codex/auth/CodexOAuthFlow";
import { CodexModelClient } from "../../adapters/codex/responses/CodexModelClient";
import { JsonAgentConfigStore } from "../../adapters/file-system/JsonAgentConfigStore";
import { JsonFileTokenStore } from "../../adapters/file-system/JsonFileTokenStore";
import { JsonlConversationStore } from "../../adapters/file-system/JsonlConversationStore";
import { SimpleLinearMemory } from "../../adapters/memory/simple-linear/SimpleLinearMemory";
import { MathTool } from "../../adapters/tools/MathTool";
import { Agent } from "../../core/agent/Agent";
import { ConversationManager } from "../../core/conversations/ConversationManager";
import { ToolRegistry } from "../../core/tools/ToolRegistry";
import type { CliRuntime } from "./CliRuntime.interface";
import { ensureRuntimeAuth } from "./auth";
import { createSettingsUpdater } from "./createSettingsUpdater";

export async function composeCliRuntime(
  cwd: string,
  options: { readonly headlessAuth?: boolean } = {},
): Promise<CliRuntime> {
  const config = await new JsonAgentConfigStore({
    filePath: join(cwd, "agent.config.json"),
  }).load();
  const conversations = new ConversationManager({
    cwd,
    store: new JsonlConversationStore({
      rootDir: join(cwd, ".agent", "conversations"),
    }),
  });
  const tokenStore = new JsonFileTokenStore({
    filePath: join(cwd, ".agent", "auth.json"),
  });
  const auth = new CodexAuthClient({ tokenStore });
  await ensureRuntimeAuth({
    tokenStore,
    oauthFlow: new CodexOAuthFlow(),
    exchangeAuthorizationCode: (input) =>
      auth.exchangeAuthorizationCode({
        code: input.authorizationCode,
        redirectUri: input.redirectUri,
        codeVerifier: input.codeVerifier,
      }),
    headless: options.headlessAuth ?? false,
    output: (line) => process.stdout.write(`${line}\n`),
  });
  const model = new CodexModelClient({
    getAccessToken: () => auth.getAccessToken(),
  });
  const tools = new ToolRegistry([new MathTool()]);
  const memory = new SimpleLinearMemory(conversations);
  return {
    config,
    conversations,
    agent: new Agent({ memory, model, tools }),
    updateConversationSettings: createSettingsUpdater(memory),
  };
}
