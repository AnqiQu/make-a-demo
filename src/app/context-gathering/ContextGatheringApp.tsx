import { useEffect, useState } from "react";

import githubLogoUrl from "../../../assets/github-logo.png";
import owletLogoUrl from "../../../assets/owl-logo.png";
import {
  type ContextGatheringDraft,
  type IntakeDetailsInput,
  type PendingSupportingFileDraft,
  type SupportingFileDraft,
  canContinueFromRepoStep,
  collectIntakeDetails,
  connectGitHubInstallation,
  createInitialContextGatheringDraft,
  removePendingSupportingFile,
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

const initialIntakeDetailsForm: IntakeDetailsInput = {
  email: "",
  importantFeatures: "",
  name: "",
  productSummary: "",
  requestedDurationSeconds: 60,
  supplementaryInformation: "",
  targetUsers: "",
};

export function ContextGatheringApp() {
  const [draft, setDraft] = useState(() =>
    createInitialContextGatheringDraft(),
  );
  const [repoInput, setRepoInput] = useState("");
  const [intakeDetailsForm, setIntakeDetailsForm] = useState(
    initialIntakeDetailsForm,
  );
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

  function updateIntakeDetailsField<Key extends keyof IntakeDetailsInput>(
    field: Key,
    value: IntakeDetailsInput[Key],
  ) {
    setIntakeDetailsForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function returnToRepoStep() {
    setDraft((current) => ({
      ...current,
      chatStep: "repo",
    }));
    setError("");
  }

  function submitDetailsForm() {
    let nextDraft: ContextGatheringDraft;
    try {
      nextDraft = collectIntakeDetails(draft, intakeDetailsForm);
      setDraft(nextDraft);
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Check the form and try again.",
      );
      return;
    }

    void submitIntake(nextDraft);
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

  async function submitIntake(draftToSubmit: ContextGatheringDraft) {
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
          contact: draftToSubmit.contact,
          contextTranscript: draftToSubmit.contextTranscript,
          githubInstallationId: draftToSubmit.githubInstallationId,
          repoUrl: draftToSubmit.repoUrl,
          repoVisibility: draftToSubmit.repoVisibility,
          structuredContext: draftToSubmit.structuredContext,
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
    <main className={`owlet-shell owlet-shell-${draft.chatStep}`}>
      <div className="ambient-glow" />
      <div className="dot-field dot-field-left" />
      <div className="dot-field dot-field-right" />
      <section className="brand" aria-label="MakeADemo">
        <span className="brand-name">MakeADemo</span>
        <aside className="brand-attribution" aria-label="By Owlet">
          <span>By Owlet</span>
          <img alt="" src={owletLogoUrl} />
        </aside>
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
            Make me a demo
          </button>
        </section>
      ) : null}

      {draft.chatStep === "details" ? (
        <ContextDetailsForm
          form={intakeDetailsForm}
          isDraggingSupportingFile={isDraggingSupportingFile}
          isSubmitting={isSubmitting}
          isUploading={isUploading}
          onBack={returnToRepoStep}
          onFieldChange={updateIntakeDetailsField}
          onRemovePendingFile={(fileId) =>
            setPendingSupportingFiles((current) =>
              removePendingSupportingFile(current, fileId),
            )
          }
          onStageFiles={stageFiles}
          onSubmit={submitDetailsForm}
          pendingSupportingFiles={pendingSupportingFiles}
          setIsDraggingSupportingFile={setIsDraggingSupportingFile}
        />
      ) : null}

      {draft.chatStep === "submitted" ? (
        <SubmittedDemoPanel progress={demoRequestProgress} />
      ) : null}

      {error ? <p className="error-banner">{error}</p> : null}
    </main>
  );
}

type ContextDetailsFormProps = {
  form: IntakeDetailsInput;
  isDraggingSupportingFile: boolean;
  isSubmitting: boolean;
  isUploading: boolean;
  onBack: () => void;
  onFieldChange: <Key extends keyof IntakeDetailsInput>(
    field: Key,
    value: IntakeDetailsInput[Key],
  ) => void;
  onRemovePendingFile: (fileId: string) => void;
  onStageFiles: (files: File[] | FileList | null) => void;
  onSubmit: () => void;
  pendingSupportingFiles: Array<PendingSupportingFileDraft<File>>;
  setIsDraggingSupportingFile?: (isDragging: boolean) => void;
};

export function ContextDetailsForm({
  form,
  isDraggingSupportingFile,
  isSubmitting,
  isUploading,
  onBack,
  onFieldChange,
  onRemovePendingFile,
  onStageFiles,
  onSubmit,
  pendingSupportingFiles,
  setIsDraggingSupportingFile,
}: ContextDetailsFormProps) {
  return (
    <section className="details-step" aria-label="Demo intake details">
      <button
        aria-label="Back to repository"
        className="back-arrow-button"
        onClick={onBack}
        type="button"
      >
        <svg
          aria-hidden="true"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.4"
        >
          <path d="M19 12H5" />
          <path d="m12 19-7-7 7-7" />
        </svg>
      </button>
      <div
        className="progress-track-shell"
        aria-label="Context Gathering progress"
      >
        <div
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={50}
          className="progress-track"
          role="progressbar"
          tabIndex={0}
        >
          <span className="progress-track-fill" />
        </div>
      </div>
      <form
        className="details-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="details-field-grid">
          <label className="details-field">
            <span>Name</span>
            <input
              autoComplete="name"
              onChange={(event) =>
                onFieldChange("name", event.currentTarget.value)
              }
              required
              value={form.name}
            />
          </label>
          <label className="details-field">
            <span>Email</span>
            <input
              autoComplete="email"
              onChange={(event) =>
                onFieldChange("email", event.currentTarget.value)
              }
              required
              type="email"
              value={form.email}
            />
          </label>
        </div>
        <label className="details-field">
          <span>Product summary</span>
          <input
            onChange={(event) =>
              onFieldChange("productSummary", event.currentTarget.value)
            }
            required
            value={form.productSummary}
          />
        </label>
        <label className="details-field">
          <span>Target users</span>
          <input
            onChange={(event) =>
              onFieldChange("targetUsers", event.currentTarget.value)
            }
            required
            value={form.targetUsers}
          />
        </label>
        <label className="details-field">
          <span>Most important features</span>
          <input
            onChange={(event) =>
              onFieldChange("importantFeatures", event.currentTarget.value)
            }
            required
            value={form.importantFeatures}
          />
        </label>
        <label className="details-field details-duration-field">
          <span>Demo length</span>
          <select
            onChange={(event) =>
              onFieldChange(
                "requestedDurationSeconds",
                Number.parseInt(event.currentTarget.value, 10),
              )
            }
            value={form.requestedDurationSeconds}
          >
            {durationOptions.map((option) => (
              <option key={option.seconds} value={option.seconds}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <section className="details-supporting-documents">
          <label
            className={`upload-zone ${
              isDraggingSupportingFile ? "upload-zone-active" : ""
            }`}
            onDragLeave={() => setIsDraggingSupportingFile?.(false)}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDraggingSupportingFile?.(true);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDraggingSupportingFile?.(false);
              onStageFiles(event.dataTransfer.files);
            }}
          >
            <input
              accept=".csv,.doc,.docx,.json,.md,.pdf,.ppt,.pptx,.txt,.zip,application/json,application/msword,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/zip,text/csv,text/markdown,text/plain"
              id="supporting-documents-upload"
              multiple
              onChange={(event) => {
                onStageFiles(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
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
            <span className="upload-example">
              E.g. pitch decks, styling guides, manifestos...
            </span>
            <span className="upload-action">Choose files</span>
            <small>PDF, PPTX, DOCX, TXT, MD, ZIP</small>
          </label>
        </section>
        {pendingSupportingFiles.length > 0 ? (
          <section
            aria-label="Selected files"
            aria-live="polite"
            className="pending-file-dock"
          >
            <p>
              {pendingSupportingFiles.length === 1
                ? "1 file selected"
                : `${pendingSupportingFiles.length} files selected`}
            </p>
            <ul className="file-list">
              {pendingSupportingFiles.map((file) => (
                <li key={file.id}>
                  <span>{file.fileName}</span>
                  <button
                    aria-label={`Remove ${file.fileName}`}
                    onClick={() => onRemovePendingFile(file.id)}
                    type="button"
                  >
                    x
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <label className="details-field">
          <span>Any supplementary information?</span>
          <input
            onChange={(event) =>
              onFieldChange(
                "supplementaryInformation",
                event.currentTarget.value,
              )
            }
            value={form.supplementaryInformation}
          />
        </label>
        <button
          className="primary-hoot"
          disabled={isSubmitting || isUploading}
          type="submit"
        >
          {isUploading
            ? "Uploading files..."
            : isSubmitting
              ? "Starting..."
              : "Let's go"}
        </button>
      </form>
    </section>
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
