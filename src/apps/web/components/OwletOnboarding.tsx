import { useState } from "react";
import {
  type OnboardingSummary,
  createOnboardingSummary,
} from "../onboardingState";
import { ChatInput } from "./ChatInput";
import { GithubConnectCard } from "./GithubConnectCard";
import { MicrophonePrompt } from "./MicrophonePrompt";
import { OwletLogo } from "./OwletLogo";
import { UploadCard } from "./UploadCard";

export function OwletOnboarding() {
  const [isListening, setIsListening] = useState(false);
  const [message, setMessage] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  const [summary, setSummary] = useState<OnboardingSummary | null>(null);

  const handleSubmit = () => {
    const nextSummary = createOnboardingSummary({
      isListening,
      message,
      repoUrl,
      uploadedFiles,
    });

    setSummary(nextSummary);
    console.info("Owlet onboarding placeholder summary", nextSummary);
  };

  return (
    <main className="relative h-dvh overflow-y-auto overflow-x-hidden bg-[#FFF7ED] p-6 text-brand-umber sm:p-8 lg:p-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.22),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(185,130,91,0.2),transparent_32%)]" />
      <section className="relative mx-auto flex min-h-full max-w-5xl items-center justify-center">
        <div className="pointer-events-none absolute inset-x-0 top-[30%] h-48 bg-[radial-gradient(ellipse_at_center,rgba(255,247,237,0)_22%,rgba(255,247,237,0.78)_70%)]" />
        <div className="pointer-events-none absolute left-0 top-2 hidden h-48 w-48 bg-[radial-gradient(circle,rgba(245,158,11,0.15)_1.5px,transparent_2px)] [background-size:28px_28px] md:block" />
        <div className="pointer-events-none absolute bottom-2 right-0 hidden h-48 w-48 bg-[radial-gradient(circle,rgba(245,158,11,0.13)_1.5px,transparent_2px)] [background-size:28px_28px] md:block" />

        <div className="relative mx-auto flex w-full max-w-[900px] flex-col items-center">
          <OwletLogo />

          <h1 className="mt-3 text-center font-heading text-[2.5rem] font-semibold leading-tight tracking-normal text-[#1f2933]">
            Let’s chat about what you’re building
          </h1>

          <MicrophonePrompt
            isListening={isListening}
            onToggle={() => setIsListening((current) => !current)}
          />

          <div className="mt-3 w-full max-w-[860px]">
            <ChatInput onSubmitMessage={setMessage} />
          </div>

          <div className="mt-4 grid w-full max-w-[860px] gap-4 lg:grid-cols-[0.78fr_1.55fr]">
            <GithubConnectCard repoUrl={repoUrl} onRepoUrlChange={setRepoUrl} />
            <UploadCard
              uploadedFiles={uploadedFiles}
              onFilesChange={setUploadedFiles}
            />
          </div>

          <button
            className="mt-4 min-h-12 w-full max-w-[240px] rounded-full bg-gradient-to-b from-[#ff8c00] to-[#ff6b00] px-7 text-base font-bold text-white shadow-[0_15px_34px_rgba(245,110,0,0.35)] transition hover:-translate-y-0.5 hover:shadow-[0_18px_38px_rgba(245,110,0,0.42)] focus:outline-none focus:ring-4 focus:ring-[#F59E0B]/25"
            type="button"
            onClick={handleSubmit}
          >
            Let’s Hoot
          </button>

          {summary ? (
            <div
              aria-live="polite"
              className="mt-4 w-full max-w-[720px] rounded-2xl border border-orange-200/80 bg-white/85 px-5 py-3 text-sm text-slate-700 shadow-soft-control"
            >
              <p className="font-semibold text-brand-umber">
                Intake saved locally
              </p>
              <p className="mt-2">
                {summary.message || "No typed message yet."}
                {summary.hasVoicePlaceholder
                  ? " Voice placeholder active."
                  : ""}
              </p>
              <p className="mt-1">
                Repo: {summary.repoUrl || "Not selected"} · Files:{" "}
                {summary.uploadedFileNames.length > 0
                  ? summary.uploadedFileNames.join(", ")
                  : "None"}
              </p>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
