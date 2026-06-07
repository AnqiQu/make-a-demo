import type { Stage1CliOptions } from "./stage1-cli-options";

type Stage1CliPrompt = (question: string) => Promise<string>;

export type Stage1CliInteractiveIO = {
  prompt: Stage1CliPrompt;
  write: (message: string) => void;
};

export async function collectStage1CliOptions(
  io: Stage1CliInteractiveIO,
): Promise<Stage1CliOptions> {
  io.write("MakeADemo Stage 1 CLI");
  io.write("Press Enter to accept defaults where shown.");

  const repoUrl = await promptUntilValid(
    io,
    "GitHub repo URL: ",
    isGitHubHttpsUrl,
    "Invalid repo URL. Use a GitHub HTTPS URL like https://github.com/owner/repo.",
  );
  const features = splitCsv(
    await promptUntilValid(
      io,
      "Key product features to demo, separated by commas: ",
      (value) => splitCsv(value).length > 0,
      "Invalid features. Provide at least one feature, separated by commas.",
    ),
  );
  const docs = splitCsv(
    await io.prompt(
      "Supporting document paths, separated by commas (optional): ",
    ),
  );
  const providerID = await promptWithDefault(io, "Model provider", "openai");
  const modelID = await promptWithDefault(io, "Model ID", "gpt-5.5");
  const workspaceId = await promptWithDefault(
    io,
    "Workspace ID",
    createWorkspaceId(repoUrl),
  );
  const workspaceRoot = await promptWithDefault(
    io,
    "Workspace root",
    "/tmp/makeademo-workspaces",
  );

  return {
    docs,
    features,
    modelID,
    providerID,
    repoUrl,
    workspaceId,
    workspaceRoot,
  };
}

async function promptUntilValid(
  io: Stage1CliInteractiveIO,
  question: string,
  validate: (value: string) => boolean,
  invalidMessage: string,
): Promise<string> {
  while (true) {
    const value = (await io.prompt(question)).trim();

    if (validate(value)) {
      return value;
    }

    io.write(invalidMessage);
  }
}

async function promptWithDefault(
  io: Stage1CliInteractiveIO,
  label: string,
  defaultValue: string,
): Promise<string> {
  const value = (await io.prompt(`${label} [${defaultValue}]: `)).trim();
  return value.length === 0 ? defaultValue : value;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isGitHubHttpsUrl(value: string): boolean {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+/.test(value);
}

function createWorkspaceId(repoUrl: string): string {
  const slug = repoUrl
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

  return `workspace-${slug}-${Date.now()}`;
}
