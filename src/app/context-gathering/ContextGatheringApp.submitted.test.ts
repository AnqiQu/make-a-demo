import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SubmittedDemoPanel } from "./ContextGatheringApp";

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
