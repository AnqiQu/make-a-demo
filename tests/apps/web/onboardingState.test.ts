import {
  type OnboardingIntakeState,
  createOnboardingSummary,
} from "../../../src/apps/web/onboardingState";

describe("createOnboardingSummary", () => {
  it("summarizes the current local intake state for placeholder submission", () => {
    const intakeState: OnboardingIntakeState = {
      isListening: true,
      message: "We build product demos from repo context.",
      repoUrl: "https://github.com/example/acme",
      uploadedFiles: ["pitch.pdf", "brand-guidelines.md"],
    };

    expect(createOnboardingSummary(intakeState)).toEqual({
      hasVoicePlaceholder: true,
      message: "We build product demos from repo context.",
      repoUrl: "https://github.com/example/acme",
      uploadedFileNames: ["pitch.pdf", "brand-guidelines.md"],
    });
  });
});
