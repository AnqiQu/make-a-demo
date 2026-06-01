export type OnboardingIntakeState = {
  isListening: boolean;
  message: string;
  repoUrl: string;
  uploadedFiles: string[];
};

export type OnboardingSummary = {
  hasVoicePlaceholder: boolean;
  message: string;
  repoUrl: string;
  uploadedFileNames: string[];
};

export function createOnboardingSummary(
  intakeState: OnboardingIntakeState,
): OnboardingSummary {
  return {
    hasVoicePlaceholder: intakeState.isListening,
    message: intakeState.message,
    repoUrl: intakeState.repoUrl,
    uploadedFileNames: [...intakeState.uploadedFiles],
  };
}
