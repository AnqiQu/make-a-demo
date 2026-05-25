#!/usr/bin/env bun
import { applyCliSettingsCommand, helpText } from "./commands";
import { composeCliRuntime } from "./composeCliRuntime";
import { renderConversationHistory } from "./conversationHistory";
import { selectInitialConversation } from "./conversationSelection";
import { createCliReadline } from "./readline";
import { CliTurnRenderer } from "./render";

async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    process.stdout.write(helpText());
    return;
  }

  const cwd = process.env.SEED_CWD ?? process.cwd();
  const { config, conversations, agent, updateConversationSettings } =
    await composeCliRuntime(cwd, {
      headlessAuth: cliArgs.includes("--headless-auth"),
    });
  const readline = createCliReadline();
  let conversation = cliArgs.includes("--resume")
    ? await conversations.resumeMostRecentOrCreate(config)
    : await selectInitialConversation({
        conversations,
        config,
        io: {
          question: (prompt) => readline.question(prompt),
          write: (text) => process.stdout.write(text),
        },
      });
  process.stdout.write(`Conversation ${conversation.id}\n`);
  process.stdout.write(
    await renderConversationHistory(conversations, conversation.id),
  );
  try {
    while (true) {
      const userInput = (await readline.question("> ")).trim();
      if (userInput.length === 0) {
        continue;
      }
      if (userInput === "/exit") {
        return;
      }
      if (userInput === "/new") {
        conversation = await conversations.createConversation(config);
        process.stdout.write(`Conversation ${conversation.id}\n`);
        continue;
      }
      if (userInput === "/resume") {
        conversation = await conversations.resumeMostRecentOrCreate(config);
        process.stdout.write(`Conversation ${conversation.id}\n`);
        process.stdout.write(
          await renderConversationHistory(conversations, conversation.id),
        );
        continue;
      }
      if (
        userInput.startsWith("/model ") ||
        userInput.startsWith("/reasoning ") ||
        userInput.startsWith("/set-json ")
      ) {
        await updateConversationSettings({
          conversationId: conversation.id,
          update: (settings) => applyCliSettingsCommand(settings, userInput),
        });
        process.stdout.write("Settings updated.\n");
        continue;
      }

      const renderer = new CliTurnRenderer();
      for await (const event of agent.runTurn({
        conversationId: conversation.id,
        userMessage: userInput,
      })) {
        const renderedEventChunk = renderer.render(event);
        if (renderedEventChunk.length > 0) {
          process.stdout.write(renderedEventChunk);
        }
      }
    }
  } finally {
    readline.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
