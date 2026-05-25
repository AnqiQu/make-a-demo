import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonAgentConfigStore } from "../../../src/adapters/file-system/JsonAgentConfigStore";

test("JSON agent config store loads known fields and response overrides", async () => {
  const filePath = await writeAgentConfig({
    systemPrompt: "Ship carefully.",
    model: "gpt-5.1",
    reasoning: { effort: "medium", summary: "auto", extra: true },
    responseOverrides: { temperature: 0.2, parallel_tool_calls: false },
  });
  const store = new JsonAgentConfigStore({ filePath });

  await expect(store.load()).resolves.toEqual({
    systemPrompt: "Ship carefully.",
    model: "gpt-5.1",
    reasoning: { effort: "medium", summary: "auto", extra: true },
    responseOverrides: { temperature: 0.2, parallel_tool_calls: false },
  });
});

test("JSON agent config store defaults response overrides", async () => {
  const filePath = await writeAgentConfig({
    systemPrompt: "Ship carefully.",
    model: "gpt-5.1",
  });
  const store = new JsonAgentConfigStore({ filePath });

  await expect(store.load()).resolves.toEqual({
    systemPrompt: "Ship carefully.",
    model: "gpt-5.1",
    responseOverrides: {},
  });
});

test("JSON agent config store reports missing config files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-config-"));
  const filePath = join(cwd, "missing.config.json");
  const store = new JsonAgentConfigStore({ filePath });

  await expect(store.load()).rejects.toMatchObject({
    code: "config_missing",
    message: `Missing agent config at ${filePath}.`,
  });
});

test("JSON agent config store reports invalid JSON", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-config-"));
  const filePath = join(cwd, "agent.config.json");
  await writeFile(filePath, "{", "utf8");
  const store = new JsonAgentConfigStore({ filePath });

  await expect(store.load()).rejects.toMatchObject({
    code: "config_invalid",
    message: `Invalid agent config at ${filePath}.`,
  });
});

test("JSON agent config store reports schema-invalid config", async () => {
  const filePath = await writeAgentConfig({
    systemPrompt: "",
    model: "gpt-5.1",
  });
  const store = new JsonAgentConfigStore({ filePath });

  await expect(store.load()).rejects.toMatchObject({
    code: "config_invalid",
    message: `Invalid agent config at ${filePath}.`,
  });
});

async function writeAgentConfig(config: unknown): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "agent-config-"));
  const filePath = join(cwd, "agent.config.json");
  await writeFile(filePath, JSON.stringify(config), "utf8");
  return filePath;
}
