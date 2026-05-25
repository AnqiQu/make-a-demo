import { readFile } from "node:fs/promises";

import {
  type AgentConfig,
  agentConfigSchema,
} from "../../core/config/AgentConfig.schema";
import type { AgentConfigStore } from "../../core/config/AgentConfigStore.interface";
import { AgentError } from "../../core/errors/AgentError";

interface JsonAgentConfigStoreOptions {
  readonly filePath: string;
}

/** Loads Agent defaults from a JSON file. */
export class JsonAgentConfigStore implements AgentConfigStore {
  readonly #filePath: string;

  constructor(options: JsonAgentConfigStoreOptions) {
    this.#filePath = options.filePath;
  }

  async load(): Promise<AgentConfig> {
    let raw: string;

    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (cause) {
      throw new AgentError({
        code: "config_missing",
        message: `Missing agent config at ${this.#filePath}.`,
        cause,
      });
    }

    try {
      return agentConfigSchema.parse(JSON.parse(raw));
    } catch (cause) {
      throw new AgentError({
        code: "config_invalid",
        message: `Invalid agent config at ${this.#filePath}.`,
        cause,
      });
    }
  }
}
