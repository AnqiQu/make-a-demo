import { z } from "zod";

import type { CliResponseSettings } from "./CliRuntime.interface";

const jsonObjectSchema = z.record(z.string(), z.unknown());

export function helpText(): string {
  return `seed

Usage:
  bun run agent [--new] [--resume] [--headless-auth]

Options:
  --headless-auth        Print the OAuth URL instead of opening a browser

Chat commands:
  /model <model>          Change the conversation model setting
  /reasoning <effort>     Change conversation reasoning effort
  /set-json <json>        Merge arbitrary Responses overrides
  /new                    Start a new conversation
  /resume                 Resume the most recent conversation
  /exit                   Quit
`;
}

/** Applies CLI-only settings commands to the current conversation settings. */
export function applyCliSettingsCommand(
  settings: CliResponseSettings,
  command: string,
): CliResponseSettings {
  const trimmed = command.trim();
  if (trimmed.startsWith("/model ")) {
    return { ...settings, model: trimmed.slice("/model ".length).trim() };
  }
  if (trimmed.startsWith("/reasoning ")) {
    return {
      ...settings,
      reasoning: {
        ...(settings.reasoning ?? {}),
        effort: trimmed.slice("/reasoning ".length).trim(),
      },
    };
  }
  if (trimmed.startsWith("/set-json ")) {
    const parsed = jsonObjectSchema.parse(
      JSON.parse(trimmed.slice("/set-json ".length)),
    );
    return {
      ...settings,
      responseOverrides: { ...settings.responseOverrides, ...parsed },
    };
  }
  return settings;
}
