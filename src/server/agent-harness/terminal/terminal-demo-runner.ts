import {
  type DefaultDemoPipelineInput,
  type DefaultDemoPipelineResult,
  runDefaultDemoPipeline,
} from "../default/default-demo-pipeline";

export type TerminalDemoInput = DefaultDemoPipelineInput;

export type TerminalQuestioner = {
  question(prompt: string): Promise<string>;
};

export type TerminalDemoRunResult = DefaultDemoPipelineResult;

export type TerminalDemoPipelineOptions = {
  runPipeline?: (
    input: DefaultDemoPipelineInput,
  ) => Promise<DefaultDemoPipelineResult>;
};

const defaultDemoLengthSeconds = 30;

export async function collectTerminalDemoInput(
  questioner: TerminalQuestioner,
): Promise<TerminalDemoInput> {
  const repoUrl = (await questioner.question("GitHub repo URL: ")).trim();
  if (repoUrl.length === 0) {
    throw new Error("GitHub repo URL is required.");
  }

  const productSummary = optionalAnswer(
    await questioner.question("Product summary (optional): "),
  );
  const targetUsers = optionalAnswer(
    await questioner.question("Target users (optional): "),
  );
  const importantFeatures = splitFeatures(
    await questioner.question("Important features (optional): "),
  );
  const demoLengthSeconds = readDemoLengthSeconds(
    await questioner.question("Demo length in seconds [30]: "),
  );

  return {
    demoLengthSeconds,
    importantFeatures,
    ...(productSummary === undefined ? {} : { productSummary }),
    repoUrl,
    ...(targetUsers === undefined ? {} : { targetUsers }),
  };
}

export async function runTerminalDemoPipeline(
  input: TerminalDemoInput,
  options: TerminalDemoPipelineOptions = {},
): Promise<TerminalDemoRunResult> {
  return await (options.runPipeline ?? runDefaultDemoPipeline)(input);
}

function optionalAnswer(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function splitFeatures(value: string): string[] {
  return value
    .split(/[\n,]/g)
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0);
}

function readDemoLengthSeconds(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return defaultDemoLengthSeconds;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "Demo length must be a positive integer number of seconds.",
    );
  }

  return parsed;
}
