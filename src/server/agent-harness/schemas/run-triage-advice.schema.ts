const runTriageHintLimit = 8;

/**
 * The bounded run-triage recommendation for a capacity-classified run.
 * Purely advisory: hints steer the Repo Preparation prompt as additive
 * guidance and the envelope-fit warning annotates the run report. No field
 * can fail, block, or reroute a run, and consumers must treat rejection of
 * this schema as "no advice".
 */
export type RunTriageAdvice = {
  envelopeFitWarning?: string;
  preparationStrategyHints: string[];
};

/** Validates the strategist-authored run-triage advice artifact. */
export function readRunTriageAdvice(value: unknown): RunTriageAdvice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("RunTriageAdvice must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = ["envelopeFitWarning", "preparationStrategyHints"];
  const unknownKey = Object.keys(record).find(
    (key) => !allowedKeys.includes(key),
  );
  if (unknownKey !== undefined) {
    throw new Error(`RunTriageAdvice.${unknownKey} is not allowed`);
  }
  const hints = record.preparationStrategyHints;
  if (!Array.isArray(hints) || hints.some((hint) => typeof hint !== "string")) {
    throw new Error(
      "RunTriageAdvice.preparationStrategyHints must be an array of strings",
    );
  }
  if (hints.length > runTriageHintLimit) {
    throw new Error(
      `RunTriageAdvice.preparationStrategyHints allows at most ${runTriageHintLimit} hints`,
    );
  }
  const preparationStrategyHints = hints.map((hint, index) => {
    const text = (hint as string).trim();
    if (text.length === 0) {
      throw new Error(
        `RunTriageAdvice.preparationStrategyHints[${index}] must be a non-empty string`,
      );
    }
    return text;
  });
  if (record.envelopeFitWarning === undefined) {
    return { preparationStrategyHints };
  }
  if (
    typeof record.envelopeFitWarning !== "string" ||
    record.envelopeFitWarning.trim().length === 0
  ) {
    throw new Error(
      "RunTriageAdvice.envelopeFitWarning must be a non-empty string",
    );
  }
  return {
    envelopeFitWarning: record.envelopeFitWarning.trim(),
    preparationStrategyHints,
  };
}
