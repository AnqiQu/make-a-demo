import { useEffect, useMemo, useRef, useState } from "react";

import githubLogoUrl from "../../../assets/github-logo.png";
import owletLogoUrl from "../../../assets/owl-logo.png";
import {
  type ContextGatheringDraft,
  type PendingSupportingFileDraft,
  type SupportingFileDraft,
  answerCurrentPrompt,
  canContinueFromRepoStep,
  connectGitHubInstallation,
  createInitialContextGatheringDraft,
  removePendingSupportingFile,
  selectDemoDuration,
  selectRepositoryForDemo,
  setRepoDetails,
  stagePendingSupportingFiles,
} from "./draft";

type InstalledRepository = {
  fullName: string;
  private: boolean;
  repoUrl: string;
};

type StoredUpload = {
  fileName: string;
  key: string;
  r2Url: string;
};

type SubmitResult = {
  demoRequestId: string;
  projectId: string;
  status: "queued";
};

type DemoRequestProgress =
  | { status: "completed"; videoUrl: string }
  | { status: "failed" }
  | { status: "processing" };

type DemoRequestStatusResponse =
  | { status: "completed"; videoUrl: string }
  | { status: "failed" | "processing" };

const durationOptions = [
  { label: "30s", seconds: 30 },
  { label: "1 min", seconds: 60 },
  { label: "2 min", seconds: 120 },
  { label: "3 min", seconds: 180 },
];

export function ContextGatheringApp() {
  const [draft, setDraft] = useState(() =>
    createInitialContextGatheringDraft(),
  );
  const [chatInput, setChatInput] = useState("");
  const [repoInput, setRepoInput] = useState("");
  const [error, setError] = useState("");
  const [repositories, setRepositories] = useState<InstalledRepository[]>([]);
  const [pendingSupportingFiles, setPendingSupportingFiles] = useState<
    Array<PendingSupportingFileDraft<File>>
  >([]);
  const [isDraggingSupportingFile, setIsDraggingSupportingFile] =
    useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [demoRequestProgress, setDemoRequestProgress] =
    useState<DemoRequestProgress>({ status: "processing" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const installationId = params.get("installation_id");
    if (!installationId) {
      return;
    }

    setError("");
    fetch(`/api/github/installations/${installationId}/repositories`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Could not load GitHub repositories");
        }
        return response.json() as Promise<{
          repositories: InstalledRepository[];
        }>;
      })
      .then(({ repositories: nextRepositories }) => {
        setRepositories(nextRepositories);
        setDraft((current) => {
          const connected = connectGitHubInstallation(current, installationId);
          const onlyRepository = nextRepositories[0];
          if (nextRepositories.length === 1 && onlyRepository) {
            setRepoInput(onlyRepository.repoUrl);
            return selectRepositoryForDemo(connected, {
              private: onlyRepository.private,
              repoUrl: onlyRepository.repoUrl,
            });
          }

          return connected;
        });
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : "GitHub failed");
      });
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      behavior: "smooth",
      top: transcriptRef.current.scrollHeight,
    });
  });

  useEffect(() => {
    if (
      draft.chatStep !== "submitted" ||
      !submitResult ||
      demoRequestProgress.status === "completed" ||
      demoRequestProgress.status === "failed"
    ) {
      return;
    }

    let cancelled = false;
    const demoRequestId = submitResult.demoRequestId;

    async function refreshDemoRequestStatus() {
      const response = await fetch(
        `/api/demo-requests/${encodeURIComponent(demoRequestId)}`,
      );

      if (!response.ok) {
        return;
      }

      const progress = (await response.json()) as DemoRequestStatusResponse;
      if (cancelled) {
        return;
      }

      setDemoRequestProgress(progress);
    }

    void refreshDemoRequestStatus();
    const interval = window.setInterval(() => {
      void refreshDemoRequestStatus();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [demoRequestProgress.status, draft.chatStep, submitResult]);

  const currentPrompt = useMemo(
    () => findLastAssistantMessage(draft.contextTranscript),
    [draft.contextTranscript],
  );
  const canContinueRepoStep = canContinueFromRepoStep(draft, repoInput);

  async function connectGitHub() {
    setError("");
    const response = await fetch(
      `/api/github/install-url?state=${encodeURIComponent(draft.draftId)}`,
    );
    if (!response.ok) {
      setError("Could not start GitHub connection.");
      return;
    }

    const { installUrl } = (await response.json()) as { installUrl: string };
    window.location.href = installUrl;
  }

  function continueFromRepo() {
    try {
      if (!repoInput.startsWith("https://github.com/")) {
        throw new Error(
          draft.githubInstallationId
            ? "Select one GitHub repository to demo."
            : "Paste a GitHub HTTPS URL.",
        );
      }

      setDraft(
        setRepoDetails(draft, {
          ...(draft.githubInstallationId === undefined
            ? {}
            : { githubInstallationId: draft.githubInstallationId }),
          repoUrl: repoInput,
          repoVisibility: draft.githubInstallationId
            ? draft.repoVisibility
            : "public",
        }),
      );
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Invalid repo URL.");
    }
  }

  function selectPrivateRepo(repository: InstalledRepository) {
    setDraft((current) =>
      selectRepositoryForDemo(current, {
        private: repository.private,
        repoUrl: repository.repoUrl,
      }),
    );
    setRepoInput(repository.repoUrl);
    setError("");
  }

  function selectRepositoryFromDropdown(repoUrl: string) {
    const repository = repositories.find((item) => item.repoUrl === repoUrl);
    if (!repository) {
      return;
    }

    selectPrivateRepo(repository);
  }

  function submitChatAnswer() {
    try {
      setDraft(answerCurrentPrompt(draft, chatInput));
      setChatInput("");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Try that again.");
    }
  }

  function chooseDuration(seconds: number) {
    try {
      setDraft(selectDemoDuration(draft, seconds));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Invalid duration.");
    }
  }

  function stageFiles(files: File[] | FileList | null) {
    const nextFiles = files ? [...files] : [];
    if (nextFiles.length === 0) {
      return;
    }

    try {
      setPendingSupportingFiles((current) =>
        stagePendingSupportingFiles(current, nextFiles),
      );
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Selection failed.");
    }
  }

  async function submitIntake() {
    setIsSubmitting(true);
    setError("");

    try {
      setIsUploading(pendingSupportingFiles.length > 0);
      const uploadedSupportingFiles = await uploadPendingSupportingFiles(
        pendingSupportingFiles,
      );
      const supportingFiles = [
        ...draft.supportingFiles,
        ...uploadedSupportingFiles,
      ];
      const response = await fetch("/api/context-gathering/submit", {
        body: JSON.stringify({
          contact: draft.contact,
          contextTranscript: draft.contextTranscript,
          githubInstallationId: draft.githubInstallationId,
          repoUrl: draft.repoUrl,
          repoVisibility: draft.repoVisibility,
          structuredContext: draft.structuredContext,
          supportingFiles,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "Could not submit demo request.");
      }

      setSubmitResult((await response.json()) as SubmitResult);
      setDemoRequestProgress({ status: "processing" });
      setPendingSupportingFiles([]);
      setDraft((current) => ({
        ...current,
        chatStep: "submitted",
        supportingFiles,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Submit failed.");
    } finally {
      setIsUploading(false);
      setIsSubmitting(false);
    }
  }

  async function uploadPendingSupportingFiles(
    files: Array<PendingSupportingFileDraft<File>>,
  ): Promise<SupportingFileDraft[]> {
    const uploadedFiles: SupportingFileDraft[] = [];

    for (const file of files) {
      const body = new FormData();
      body.set("draftId", draft.draftId);
      body.set("file", file.file);

      const uploadResponse = await fetch("/api/uploads", {
        body,
        method: "POST",
      });

      if (!uploadResponse.ok) {
        const errorBody = (await uploadResponse.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          errorBody?.error ?? `Could not upload ${file.fileName}`,
        );
      }

      const upload = (await uploadResponse.json()) as StoredUpload;
      uploadedFiles.push({
        fileName: upload.fileName,
        mimeType: file.mimeType,
        r2Key: upload.key,
        r2Url: upload.r2Url,
        sizeBytes: file.sizeBytes,
      });
    }

    return uploadedFiles;
  }

  return (
    <main className="owlet-shell">
      <div className="ambient-glow" />
      <div className="dot-field dot-field-left" />
      <div className="dot-field dot-field-right" />
      <section className="brand" aria-label="Owlet">
        <span className="brand-logo-frame" aria-hidden="true">
          <img alt="" className="brand-logo-image" src={owletLogoUrl} />
        </span>
        <span className="brand-name">Owlet</span>
      </section>

      {draft.chatStep === "repo" ? (
        <section className="repo-step" aria-label="GitHub repository">
          <h1>A peak into our personalised demo machine</h1>
          <article className="repo-panel">
            <div className="repo-connect-row">
              <label className="repo-url-input">
                <span className="link-icon" aria-hidden="true">
                  <svg
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2.4"
                  >
                    <title>Repository link</title>
                    <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.43" />
                    <path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07l1.33-1.33" />
                  </svg>
                </span>
                <input
                  aria-label="GitHub repository URL"
                  onChange={(event) => setRepoInput(event.currentTarget.value)}
                  placeholder="https://github.com/your-org/your-repo"
                  value={repoInput}
                />
              </label>
              <span className="or-label">OR</span>
              <button
                className={`github-button ${
                  draft.githubInstallationId ? "github-button-connected" : ""
                }`}
                onClick={() =>
                  draft.githubInstallationId ? undefined : void connectGitHub()
                }
                type="button"
              >
                <span className="github-logo-frame" aria-hidden="true">
                  <img
                    alt=""
                    className="github-logo-image"
                    src={githubLogoUrl}
                  />
                </span>
                {draft.githubInstallationId ? (
                  <>
                    <span aria-hidden="true">✓</span>
                    GitHub connected
                  </>
                ) : (
                  "Connect GitHub"
                )}
              </button>
              {repositories.length > 1 ? (
                <label className="repo-select-field">
                  <span>Select one repository to demo</span>
                  <select
                    aria-label="Select one GitHub repository to demo"
                    onChange={(event) =>
                      selectRepositoryFromDropdown(event.currentTarget.value)
                    }
                    value={draft.repoUrl}
                  >
                    <option value="">Choose a repository</option>
                    {repositories.map((repository) => (
                      <option
                        key={repository.repoUrl}
                        value={repository.repoUrl}
                      >
                        {repository.fullName}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {repositories.length === 1 && draft.repoUrl ? (
                <p className="repo-selected-note">
                  ✓ Selected {repositories[0]?.fullName}
                </p>
              ) : null}
            </div>
          </article>
          <p className="repo-help">
            Paste a public GitHub URL, or connect GitHub to grant access to a
            private repository. 
            <br />
            We currently support web apps built with JavaScript or TypeScript.
          </p>
          <button
            className="primary-hoot"
            disabled={!canContinueRepoStep}
            onClick={continueFromRepo}
            type="button"
          >
            Let&apos;s Hoot
          </button>
        </section>
      ) : null}

      {draft.chatStep === "chat" ? (
        <section className="chat-step" aria-label="Product context chat">
          <h1 className="context-step-heading">
            Please tell us more about your product
          </h1>
          <article className="chat-card">
            <div className="chat-window" ref={transcriptRef}>
              {draft.contextTranscript.map((message) => (
                <article
                  className={`chat-bubble chat-bubble-${message.role}`}
                  key={message.id}
                >
                  {message.text}
                </article>
              ))}
            </div>
            {currentPrompt?.promptId === "demo-duration" ? (
              <div className="duration-grid">
                {durationOptions.map((option) => (
                  <button
                    key={option.seconds}
                    onClick={() => chooseDuration(option.seconds)}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : (
              <form
                className="chat-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitChatAnswer();
                }}
              >
                <input
                  aria-label="Chat response"
                  onChange={(event) => setChatInput(event.currentTarget.value)}
                  placeholder="Chat with us about it here"
                  value={chatInput}
                />
                <button disabled={chatInput.trim().length === 0} type="submit">
                  Send
                </button>
              </form>
            )}
          </article>
        </section>
      ) : null}

      {draft.chatStep === "documents" ? (
        <section className="documents-step" aria-label="Supporting Documents">
          <article className="document-card">
            <h1>
              Are there any documents that could be useful to making the demo?
            </h1>
            <p>E.g. pitch decks, styling guides, manifestos...</p>
            <label
              className={`upload-zone ${
                isDraggingSupportingFile ? "upload-zone-active" : ""
              }`}
              onDragLeave={() => setIsDraggingSupportingFile(false)}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDraggingSupportingFile(true);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setIsDraggingSupportingFile(false);
                stageFiles(event.dataTransfer.files);
              }}
            >
              <input
                accept=".csv,.doc,.docx,.json,.md,.pdf,.ppt,.pptx,.txt,.zip,application/json,application/msword,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/zip,text/csv,text/markdown,text/plain"
                multiple
                onChange={(event) => {
                  stageFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
                id="supporting-documents-upload"
                type="file"
              />
              <span className="upload-icon" aria-hidden="true">
                <svg
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2.4"
                >
                  <title>Upload</title>
                  <path d="M12 20V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </span>
              <strong>
                {isUploading ? "Uploading..." : "Drop anything relevant here"}
              </strong>
              <span className="upload-action">Choose files</span>
              <small>PDF, PPTX, DOCX, TXT, MD, ZIP</small>
            </label>
          </article>
          {pendingSupportingFiles.length > 0 ? (
            <section
              aria-label="Selected Supporting Documents"
              aria-live="polite"
              className="pending-file-dock"
            >
              <p>
                {pendingSupportingFiles.length === 1
                  ? "1 document selected"
                  : `${pendingSupportingFiles.length} documents selected`}
              </p>
              <ul className="file-list">
                {pendingSupportingFiles.map((file) => (
                  <li key={file.id}>
                    <span>{file.fileName}</span>
                    <button
                      aria-label={`Remove ${file.fileName}`}
                      onClick={() =>
                        setPendingSupportingFiles((current) =>
                          removePendingSupportingFile(current, file.id),
                        )
                      }
                      type="button"
                    >
                      x
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <button
            className="primary-hoot"
            disabled={isSubmitting || isUploading}
            onClick={() => void submitIntake()}
            type="button"
          >
            {isUploading
              ? "Uploading files..."
              : isSubmitting
                ? "Hooting..."
                : "Let’s Hoot fr now"}
          </button>
        </section>
      ) : null}

      {draft.chatStep === "submitted" ? (
        <SubmittedDemoPanel progress={demoRequestProgress} />
      ) : null}

      {error ? <p className="error-banner">{error}</p> : null}
    </main>
  );
}

export function SubmittedDemoPanel({
  progress,
}: {
  progress: DemoRequestProgress;
}) {
  if (progress.status === "completed") {
    return (
      <section className="submitted-step" aria-label="Generated demo video">
        <h1>Your demo is ready</h1>
        <video
          className="generated-demo-video"
          controls
          playsInline
          src={progress.videoUrl}
        >
          <track
            default
            kind="captions"
            label="Captions"
            src="data:text/vtt,WEBVTT"
            srcLang="en"
          />
        </video>
      </section>
    );
  }

  if (progress.status === "failed") {
    return (
      <section className="submitted-step" aria-label="Demo processing failed">
        <h1>We couldn&apos;t finish your demo</h1>
        <p>We will follow up by email with the next best step.</p>
      </section>
    );
  }

  return (
    <section className="submitted-step" aria-label="Demo processing">
      <div className="loading-ring" aria-hidden="true" />
      <h1>Your demo is processing</h1>
      <p>
        Your demo video should be finished processing in a few min, but in case
        you leave the site, we will send you an email to it once its done
      </p>
    </section>
  );
}

function findLastAssistantMessage(
  transcript: ContextGatheringDraft["contextTranscript"],
) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index];
    if (message?.role === "assistant") {
      return message;
    }
  }

  return undefined;
}
