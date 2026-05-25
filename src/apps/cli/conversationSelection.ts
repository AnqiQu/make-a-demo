import type {
  CliAgentConfig,
  CliConversationSummary,
  CliConversations,
  CliCreatedConversation,
} from "./CliRuntime.interface";

type ConversationSelectionManager = Pick<
  CliConversations,
  "listConversations" | "createConversation" | "activateConversation"
>;

/**
 * User interaction seam for selecting an initial Conversation in the CLI.
 * Implementations must present prompts and writes in order and resolve each
 * question with exactly the user input that should be parsed by selection code.
 */
export interface ConversationSelectionIo {
  readonly question: (prompt: string) => Promise<string>;
  readonly write: (text: string) => void;
}

export function formatConversationChoices(
  conversations: readonly CliConversationSummary[],
): string {
  const lines = ["Choose a conversation:", "  1. New conversation"];
  conversations.forEach((conversation, index) => {
    lines.push(`  ${index + 2}. ${formatConversationLabel(conversation)}`);
  });
  return `${lines.join("\n")}\n`;
}

export function resolveConversationSelection(
  input: string,
  conversationCount: number,
):
  | { readonly type: "new" }
  | { readonly type: "existing"; readonly index: number }
  | null {
  const selected = Number.parseInt(input.trim(), 10);
  if (!Number.isInteger(selected)) {
    return null;
  }
  if (selected === 1) {
    return { type: "new" };
  }
  const index = selected - 2;
  if (index >= 0 && index < conversationCount) {
    return { type: "existing", index };
  }
  return null;
}

/** Presents saved conversations by number so users do not need to remember IDs. */
export async function selectInitialConversation(dependencies: {
  readonly conversations: ConversationSelectionManager;
  readonly config: CliAgentConfig;
  readonly io: ConversationSelectionIo;
}): Promise<CliCreatedConversation> {
  const existing = await dependencies.conversations.listConversations();
  if (existing.length === 0) {
    dependencies.io.write(
      "No existing conversations found. Creating a new conversation.\n",
    );
    return dependencies.conversations.createConversation(dependencies.config);
  }

  dependencies.io.write(formatConversationChoices(existing));
  while (true) {
    const answer = await dependencies.io.question(
      "Select conversation number: ",
    );
    const selection = resolveConversationSelection(answer, existing.length);
    if (!selection) {
      dependencies.io.write(
        `Enter a number from 1 to ${existing.length + 1}.\n`,
      );
      continue;
    }
    if (selection.type === "new") {
      return dependencies.conversations.createConversation(dependencies.config);
    }

    const selected = existing[selection.index];
    if (!selected) {
      dependencies.io.write(
        `Enter a number from 1 to ${existing.length + 1}.\n`,
      );
      continue;
    }
    return dependencies.conversations.activateConversation(
      selected.id,
      dependencies.config,
    );
  }
}

function formatConversationLabel(conversation: CliConversationSummary): string {
  return `${new Date(conversation.timestamp).toLocaleString()} (${conversation.id.slice(0, 8)})`;
}
