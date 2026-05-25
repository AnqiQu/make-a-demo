import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ConversationRecord,
  ConversationSummary,
  ConversationTurn,
} from "../../core/conversations/ConversationRecord.interface";
import {
  conversationHeaderSchema,
  conversationTurnSchema,
} from "../../core/conversations/ConversationRecord.schema";
import type { ConversationStore } from "../../core/conversations/ConversationStore.interface";
import { AgentError } from "../../core/errors/AgentError";

interface JsonlConversationStoreOptions {
  readonly rootDir: string;
}

/** File-backed JSONL conversation store used by the CLI harness and tests. */
export class JsonlConversationStore implements ConversationStore {
  readonly #rootDir: string;
  readonly #pathsById = new Map<string, string>();

  constructor(options: JsonlConversationStoreOptions) {
    this.#rootDir = options.rootDir;
  }

  async create(record: ConversationRecord): Promise<string> {
    await mkdir(this.#rootDir, { recursive: true });
    const filePath = join(
      this.#rootDir,
      `${record.header.createdAt.replaceAll(":", "-")}_${record.header.id}.jsonl`,
    );
    await this.#write(filePath, record);
    this.#pathsById.set(record.header.id, filePath);
    return filePath;
  }

  async read(conversationId: string): Promise<ConversationRecord> {
    const filePath = await this.#pathForConversation(conversationId);
    const lines = (await readFile(filePath, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const [headerLine, ...turnLines] = lines;
    if (!headerLine) {
      throw new AgentError({
        code: "conversation_invalid",
        message: `Conversation file ${filePath} is empty.`,
      });
    }

    try {
      return {
        header: conversationHeaderSchema.parse(JSON.parse(headerLine)),
        turns: turnLines.map((line) =>
          conversationTurnSchema.parse(JSON.parse(line)),
        ) as ConversationTurn[],
      };
    } catch (cause) {
      throw new AgentError({
        code: "conversation_invalid",
        message: `Conversation file ${filePath} is invalid.`,
        cause,
      });
    }
  }

  async write(record: ConversationRecord): Promise<void> {
    const filePath = await this.#pathForConversation(record.header.id);
    await this.#write(filePath, record);
  }

  async list(): Promise<readonly ConversationSummary[]> {
    await mkdir(this.#rootDir, { recursive: true });
    const names = await readdir(this.#rootDir);
    const summaries: ConversationSummary[] = [];
    for (const name of names.filter((file) => file.endsWith(".jsonl"))) {
      const filePath = join(this.#rootDir, name);
      const firstLine = (await readFile(filePath, "utf8")).split("\n")[0];
      if (!firstLine) {
        continue;
      }
      const header = conversationHeaderSchema.parse(JSON.parse(firstLine));
      this.#pathsById.set(header.id, filePath);
      summaries.push({
        id: header.id,
        filePath,
        timestamp: header.createdAt,
        updatedAt: header.updatedAt,
        title: header.title,
      });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async #write(filePath: string, record: ConversationRecord): Promise<void> {
    const lines = [record.header, ...record.turns].map((entry) =>
      JSON.stringify(entry),
    );
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  }

  async #pathForConversation(conversationId: string): Promise<string> {
    const cached = this.#pathsById.get(conversationId);
    if (cached) {
      return cached;
    }
    const match = (await this.list()).find(
      (summary) => summary.id === conversationId,
    );
    if (!match) {
      throw new AgentError({
        code: "conversation_missing",
        message: `Conversation ${conversationId} does not exist.`,
      });
    }
    return match.filePath;
  }
}
