import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ContextDetailsForm,
  ContextGatheringApp,
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
    expect(html).toContain("By Owlet");
    expect(html).toContain("Make me a demo");
    expect(html).not.toContain("Let&#x27;s Hoot");
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
          supplementaryInformation: "",
          targetUsers: "",
        },
        isDraggingSupportingFile: false,
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
    expect(html).toContain("Any supplementary information?");
    expect(html).toContain("E.g. pitch decks, styling guides, manifestos...");
    expect(html).toContain("Let&#x27;s go");
    expect(html.match(/required=""/g)?.length).toBe(2);
    expect(html).not.toContain("Tell us what the demo should show");
    expect(html).not.toContain("Supporting Documents");
    expect(html).not.toContain("<h2>Supporting documents</h2>");
    expect(html).not.toContain("Chat response");
    expect(html).not.toContain("<textarea");
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
