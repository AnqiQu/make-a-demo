import { readRunTriageAdvice } from "./run-triage-advice.schema";

describe("readRunTriageAdvice", () => {
  it("accepts hints with an optional envelope-fit warning", () => {
    expect(
      readRunTriageAdvice({
        envelopeFitWarning:
          "  The default lifecycle risks exceeding the heavyweight sandbox envelope.  ",
        preparationStrategyHints: [
          " Prefer the development server over a production build. ",
          "Seed demo data through fixtures instead of service migrations.",
        ],
      }),
    ).toEqual({
      envelopeFitWarning:
        "The default lifecycle risks exceeding the heavyweight sandbox envelope.",
      preparationStrategyHints: [
        "Prefer the development server over a production build.",
        "Seed demo data through fixtures instead of service migrations.",
      ],
    });
    expect(readRunTriageAdvice({ preparationStrategyHints: [] })).toEqual({
      preparationStrategyHints: [],
    });
  });

  it("rejects malformed advice so triage fails open", () => {
    expect(() => readRunTriageAdvice(null)).toThrow(
      "RunTriageAdvice must be an object",
    );
    expect(() => readRunTriageAdvice({})).toThrow(
      "RunTriageAdvice.preparationStrategyHints must be an array of strings",
    );
    expect(() =>
      readRunTriageAdvice({ preparationStrategyHints: ["  "] }),
    ).toThrow(
      "RunTriageAdvice.preparationStrategyHints[0] must be a non-empty string",
    );
    expect(() =>
      readRunTriageAdvice({
        preparationStrategyHints: Array.from(
          { length: 9 },
          (_, index) => `hint ${index}`,
        ),
      }),
    ).toThrow("RunTriageAdvice.preparationStrategyHints allows at most 8");
    expect(() =>
      readRunTriageAdvice({
        envelopeFitWarning: "",
        preparationStrategyHints: [],
      }),
    ).toThrow("RunTriageAdvice.envelopeFitWarning must be a non-empty string");
    expect(() =>
      readRunTriageAdvice({
        preparationStrategyHints: [],
        stopRun: true,
      }),
    ).toThrow("RunTriageAdvice.stopRun is not allowed");
  });
});
