import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ContextDetailsForm,
  ContextGatheringApp,
  RepoConnectionFields,
  SubmittedDemoPanel,
} from "./ContextGatheringApp";

describe("ContextGatheringApp", () => {
  it("sets expectations for the supported project type during Context Gathering", () => {
    const html = renderToStaticMarkup(createElement(ContextGatheringApp));

    expect(html).toContain(
      "We currently support web apps built with JavaScript or TypeScript.",
    );
  });

  it("brands the product as MakeADemo with Owlet attribution", () => {
    const html = renderToStaticMarkup(createElement(ContextGatheringApp));

    expect(html).toContain("MakeADemo");
    expect(html).toContain("by Owlet");
    expect(html).toContain("Make me a demo");
    expect(html).not.toContain("A peak into our personalised demo machine");
    expect(html).not.toContain("Let&#x27;s Hoot");
  });

  it("keeps the Owlet attribution in one stable brand position across Context Gathering pages", () => {
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).not.toContain(".owlet-shell-details .brand-attribution");
    expect(styles).not.toContain(".owlet-shell-submitted .brand-attribution");
  });

  it("keeps repository entry choices on one row above the compact demo submit button", () => {
    const html = renderToStaticMarkup(createElement(ContextGatheringApp));
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );

    expect(html).toContain('class="repo-connect-row"');
    expect(html).toContain("OR");
    expect(html).toContain('class="primary-hoot repo-submit-button"');
    expect(html).toContain('aria-label="Make me a demo"');
    expect(styles).toContain("width: min(100%, 68rem);");
    expect(styles).toContain("width: max-content;");
    expect(styles).toContain("min-width: 0;");
  });

  it("uses the repository URL field as the connected repository dropdown", () => {
    const html = renderToStaticMarkup(
      createElement(RepoConnectionFields, {
        githubInstallationId: "installation-123",
        isLoadingRepositories: false,
        onConnectGitHub: () => undefined,
        onRepoInputChange: () => undefined,
        onRepositorySelect: () => undefined,
        repoInput: "",
        repositories: [
          {
            fullName: "example/private-app",
            private: true,
            repoUrl: "https://github.com/example/private-app",
          },
          {
            fullName: "example/another-app",
            private: true,
            repoUrl: "https://github.com/example/another-app",
          },
        ],
        selectedRepoUrl: "https://github.com/example/private-app",
      }),
    );
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );

    expect(html).toContain('class="repo-url-input repo-url-select"');
    expect(html).toContain('aria-label="Select one GitHub repository to demo"');
    expect(html).toContain("example/private-app");
    expect(html).toContain('class="repo-select-chevron"');
    expect(html).not.toContain('class="repo-select-field"');
    expect(html).not.toContain('class="button-icon"');
    expect(html).not.toContain(">OR<");
    expect(html).toContain('class="or-label or-label-connected"');
    expect(styles).toContain(
      "grid-template-columns: minmax(0, 1fr) auto auto;",
    );
    expect(styles).toContain("grid-column: 3;");
  });

  it("shows GitHub as connected while connected repositories are still loading", () => {
    const html = renderToStaticMarkup(
      createElement(RepoConnectionFields, {
        githubInstallationId: "installation-123",
        isLoadingRepositories: true,
        onConnectGitHub: () => undefined,
        onRepoInputChange: () => undefined,
        onRepositorySelect: () => undefined,
        repoInput: "",
        repositories: [],
        selectedRepoUrl: "",
      }),
    );

    expect(html).toContain("Connected");
    expect(html).toContain("Loading repositories...");
    expect(html).not.toContain("Connect GitHub");
    expect(html).not.toContain("https://github.com/org/repo");
  });
});

describe("ContextDetailsForm", () => {
  it("renders the combined second page as a halfway-progress form", () => {
    const html = renderToStaticMarkup(
      createElement(ContextDetailsForm, {
        form: {
          email: "",
          importantFeatures: "",
          name: "",
          productSummary: "",
          requestedDurationSeconds: 60,
          targetUsers: "",
        },
        isSubmitting: false,
        isUploading: false,
        onBack: () => undefined,
        onFieldChange: () => undefined,
        onRemovePendingFile: () => undefined,
        onStageFiles: () => undefined,
        onSubmit: () => undefined,
        pendingSupportingFiles: [],
      }),
    );

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('aria-label="Back to repository"');
    expect(html).toContain('class="required-marker"');
    expect(html).toContain(
      "Optional supporting docs (e.g. pitch decks, styling guides, manifestos...)",
    );
    expect(html).toContain("click to upload...");
    expect(html).toContain(
      'aria-label="Accepted file types: PDF, PPTX, DOCX, TXT, MD"',
    );
    expect(html).toContain("Let&#x27;s go");
    expect(html.match(/required=""/g)?.length).toBe(2);
    expect(html).not.toContain("Tell us what the demo should show");
    expect(html).not.toContain("Supporting Documents");
    expect(html).not.toContain("<h2>Supporting documents</h2>");
    expect(html).not.toContain("Drop anything relevant here");
    expect(html).not.toContain("ZIP");
    expect(html).not.toContain("Chat response");
    expect(html).not.toContain("<textarea");
  });

  it("keeps selected Supporting Documents inside the upload field", () => {
    const html = renderToStaticMarkup(
      createElement(ContextDetailsForm, {
        form: {
          email: "",
          importantFeatures: "",
          name: "",
          productSummary: "",
          requestedDurationSeconds: 60,
          targetUsers: "",
        },
        isSubmitting: false,
        isUploading: false,
        onBack: () => undefined,
        onFieldChange: () => undefined,
        onRemovePendingFile: () => undefined,
        onStageFiles: () => undefined,
        onSubmit: () => undefined,
        pendingSupportingFiles: [
          {
            file: new File(["deck"], "Launch Deck.pdf", {
              type: "application/pdf",
            }),
            fileName: "Launch Deck.pdf",
            id: "file-1",
            mimeType: "application/pdf",
            sizeBytes: 4,
          },
        ],
      }),
    );

    expect(html).toContain("Launch Deck.pdf");
    expect(html).toContain("click to upload again");
    expect(html).toContain('aria-label="Remove Launch Deck.pdf"');
    expect(html).not.toContain("1 file selected");
  });
});

describe("SubmittedDemoPanel", () => {
  it("shows processing without exposing the Demo Request id", () => {
    const html = renderToStaticMarkup(
      createElement(SubmittedDemoPanel, {
        progress: { status: "processing" },
      }),
    );

    expect(html).toContain("Your demo is processing");
    expect(html).not.toContain("Request");
    expect(html).not.toContain("demo-request");
  });

  it("shows the completed demo video without the loading state", () => {
    const html = renderToStaticMarkup(
      createElement(SubmittedDemoPanel, {
        progress: {
          status: "completed",
          videoUrl: "/api/demo-requests/demo-request-1/video",
        },
      }),
    );

    expect(html).toContain("<video");
    expect(html).toContain("/api/demo-requests/demo-request-1/video");
    expect(html).toContain("Your demo is ready");
    expect(html).not.toContain("loading-ring");
    expect(html).not.toContain("Your demo is processing");
  });
});
