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

  it("brands the product as MakeADemo without Owlet attribution", () => {
    const html = renderToStaticMarkup(createElement(ContextGatheringApp));

    expect(html).toContain("MakeADemo");
    expect(html).not.toContain("by Owlet");
    expect(html).toContain("Make me a demo");
    expect(html).not.toContain("A peak into our personalised demo machine");
    expect(html).not.toContain("Let&#x27;s Hoot");
  });

  it("does not reserve layout for removed Owlet attribution", () => {
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).not.toContain("brand-attribution");
  });

  it("draws six filled background clouds from compact pixel blocks at irregular sky positions", () => {
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );
    const cloudRule = styles.match(/\.owlet-shell::before\s*\{([^}]*)\}/)?.[1];
    const cloudBlockWidths = [
      ...(cloudRule?.matchAll(/(\d+)px\s+\d+px/g) ?? []),
    ].map((match) => Number.parseInt(match[1] ?? "", 10));

    expect(cloudBlockWidths).toHaveLength(54);
    expect(cloudBlockWidths.filter((width) => width >= 90)).toHaveLength(0);
    expect(cloudBlockWidths.filter((width) => width <= 64).length).toBe(54);
    expect(
      cloudRule?.match(/calc\((?:4|18|34|57|71|86)vw/g) ?? [],
    ).toHaveLength(54);
  });

  it("draws six small stars in the sky", () => {
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );
    const shellRule = styles.slice(
      styles.indexOf(".owlet-shell {"),
      styles.indexOf(".ground-bushes"),
    );

    expect(
      shellRule.match(/linear-gradient\(#fff5a6, #fff5a6\)/g),
    ).toHaveLength(6);
  });

  it("places the twelve illustrated ground bushes in the requested order", () => {
    const html = renderToStaticMarkup(createElement(ContextGatheringApp));
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );
    const shellRule = styles.slice(
      styles.indexOf(".owlet-shell {"),
      styles.indexOf(".owlet-shell::before"),
    );
    const bushSources = [
      ...html.matchAll(/<img[^>]+class="ground-bush[^>]+>/g),
    ].map(([image]) => image.match(/src="([^"]+)"/)?.[1]);

    expect(bushSources).toEqual(
      [5, 2, 6, 1, 3, 4, 2, 4, 1, 6, 5, 3].map(
        (number) => `/assets/background/bushes/bush_${number}.svg`,
      ),
    );
    expect(shellRule).not.toContain("135deg");
  });

  it("uses one shared size and keeps lowered ground bushes behind the brown strip", () => {
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );
    const bushesRule = styles.match(/\.ground-bushes\s*\{([^}]*)\}/)?.[1];
    const bushRule = styles.match(/\.ground-bush\s*\{([^}]*)\}/)?.[1];
    const groundStripRule = styles.match(
      /\.owlet-shell::after\s*\{([^}]*)\}/,
    )?.[1];
    const positionRules = styles.match(/\.ground-bush-\d{2}\s*\{[^}]*\}/g);

    expect(bushesRule).toContain("z-index: 0;");
    expect(groundStripRule).toContain("z-index: 1;");
    expect(bushRule).toContain("width: clamp(96px, 15vw, 240px);");
    expect(bushRule).toContain("transform: translateY(10%);");
    expect(positionRules).toHaveLength(12);
    expect(
      new Set(positionRules?.map((rule) => rule.match(/bottom: (\d+)px/)?.[1]))
        .size,
    ).toBeGreaterThan(3);
    expect(positionRules?.[4]).toContain("transform: translateY(15%);");
    expect(positionRules?.[11]).toContain("right: -5vw;");
    expect(positionRules?.[11]).toContain("transform: translateY(15%);");
  });

  it("places repo submission beside the URL field with one GitHub access guidance sentence", () => {
    const html = renderToStaticMarkup(createElement(ContextGatheringApp));
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );

    expect(html).toContain('class="repo-url-submit-row"');
    expect(html).toContain('class="primary-hoot repo-submit-button"');
    expect(html).toContain('aria-label="Make me a demo"');
    expect(html).toContain(
      "Paste a public GitHub URL, or connect GitHub to use a private repository.",
    );
    expect(html).toContain(
      "We currently support web apps built with JavaScript or TypeScript.",
    );
    expect(html).not.toContain('class="repo-or-divider"');
    expect(html).not.toContain(">OR<");
    expect(html).not.toContain("Paste a public GitHub URL</p>");
    expect(styles).toContain(".repo-guidance,\n.repo-help");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr) auto;");
    expect(styles).toContain("min-width: 0;");
  });

  it("does not apply hover feedback to disabled submit buttons", () => {
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toContain(".primary-hoot:not(:disabled):hover");
    expect(styles).not.toMatch(/\.primary-hoot:hover/);
  });

  it("keeps disabled buttons fully opaque", () => {
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );
    const disabledButtonRule = styles.match(
      /button:disabled\s*\{([^}]*)\}/,
    )?.[1];

    expect(disabledButtonRule).toContain("opacity: 1;");
  });

  it("uses the original orange for every submit button", () => {
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );
    const submitButtonRule = styles.match(/\.primary-hoot\s*\{([^}]*)\}/)?.[1];

    expect(submitButtonRule).toContain("background: #ffb22d;");
  });

  it("uses the requested purple for the GitHub connection button", () => {
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );
    const githubButtonRule = styles.match(/\.github-button\s*\{([^}]*)\}/)?.[1];

    expect(githubButtonRule).toContain("background: #26115f;");
  });

  it("gives each Context Gathering button a color-matched border-join bevel that inverts only while clicked", () => {
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
    );
    const bevelRule = styles.match(
      /\.owlet-shell button::after\s*\{([^}]*)\}/,
    )?.[1];
    const activeBevelRule = styles.match(
      /\.owlet-shell button:not\(:disabled\):active::after\s*\{([^}]*)\}/,
    )?.[1];

    expect(bevelRule).toContain("border-style: solid;");
    expect(bevelRule).toContain("border-width: var(--button-bevel-size);");
    expect(bevelRule?.replace(/\s+/g, " ")).toContain(
      "border-color: var(--button-bevel-highlight) var(--button-bevel-shadow) var(--button-bevel-shadow) var(--button-bevel-highlight);",
    );
    expect(bevelRule).not.toContain("mask-composite");
    expect(styles).not.toContain(
      ".owlet-shell button:not(:disabled):hover::after",
    );
    expect(activeBevelRule?.replace(/\s+/g, " ")).toContain(
      "border-color: var(--button-bevel-shadow) var(--button-bevel-highlight) var(--button-bevel-highlight) var(--button-bevel-shadow);",
    );
    expect(activeBevelRule).toContain("transition: none;");
    expect(styles).toMatch(
      /\.primary-hoot:not\(:disabled\):hover\s*\{[^}]*box-shadow: 5px 5px 0 #111827;[^}]*transform: translate\(3px, 3px\);/s,
    );
    expect(styles).toMatch(
      /\.primary-hoot\s*\{[^}]*--button-bevel-highlight: #ffe781;[^}]*--button-bevel-shadow: #df6d18;/s,
    );
    expect(styles).toMatch(
      /\.github-button\s*\{[^}]*--button-bevel-highlight: #5b3da1;[^}]*--button-bevel-shadow: #10072a;/s,
    );
    expect(styles).toMatch(
      /\.github-button-connected\s*\{[^}]*--button-bevel-highlight: #4fba78;[^}]*--button-bevel-shadow: #075229;/s,
    );
  });

  it("uses the repository URL field as the connected repository dropdown", () => {
    const html = renderToStaticMarkup(
      createElement(RepoConnectionFields, {
        canSubmitRepository: true,
        githubInstallationId: "installation-123",
        isLoadingRepositories: false,
        onConnectGitHub: () => undefined,
        onRepoInputChange: () => undefined,
        onRepositorySelect: () => undefined,
        onSubmitRepository: () => undefined,
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
    expect(html).not.toContain('class="repo-or-divider"');
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr) auto;");
    expect(styles).toContain("grid-column: 3;");
  });

  it("shows GitHub as connected while connected repositories are still loading", () => {
    const html = renderToStaticMarkup(
      createElement(RepoConnectionFields, {
        canSubmitRepository: false,
        githubInstallationId: "installation-123",
        isLoadingRepositories: true,
        onConnectGitHub: () => undefined,
        onRepoInputChange: () => undefined,
        onRepositorySelect: () => undefined,
        onSubmitRepository: () => undefined,
        repoInput: "",
        repositories: [],
        selectedRepoUrl: "",
      }),
    );

    expect(html).toContain("Connected");
    expect(html).toContain("github-connected-check");
    expect(html).toContain("Loading repositories...");
    expect(html).not.toContain(">Connect GitHub</button>");
    expect(html).not.toContain("https://github.com/org/repo");
  });

  it("lets users reconnect GitHub when connected repositories fail to load", () => {
    const html = renderToStaticMarkup(
      createElement(RepoConnectionFields, {
        canSubmitRepository: false,
        githubInstallationId: "installation-123",
        isLoadingRepositories: false,
        onConnectGitHub: () => undefined,
        onRepoInputChange: () => undefined,
        onRepositorySelect: () => undefined,
        onSubmitRepository: () => undefined,
        repoInput: "",
        repositories: [],
        selectedRepoUrl: "",
      }),
    );

    expect(html).toContain("No repositories found");
    expect(html).toContain("Reconnect GitHub");
    expect(html).toContain(
      '<button class="github-button github-button-connected" type="button">',
    );
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
    const styles = readFileSync(
      new URL("../styles.css", import.meta.url),
      "utf8",
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
    expect(html).toContain('aria-label="Submit demo intake"');
    expect(html).toContain('class="primary-hoot details-submit-button"');
    expect(html).toContain("lucide-arrow-right");
    expect(styles).toContain(".repo-submit-button,\n.details-submit-button");
    expect(styles).toContain("height: 3.9rem;");
    expect(styles).toContain("justify-self: center;");
    expect(styles).toContain("width: 5.4rem;");
    expect(styles).toContain(".details-form .file-type-tooltip");
    expect(styles).toContain("background: transparent;");
    expect(styles).not.toContain(
      ".details-form button:not(.details-submit-button)",
    );
    expect(html.match(/required=""/g)?.length).toBe(2);
    expect(html).not.toContain("Let&#x27;s go");
    expect(html).not.toContain("Starting...");
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
