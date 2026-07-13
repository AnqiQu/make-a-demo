import { describe, expect, it } from "vitest";
import type { FlowSpec } from "../schemas/artifacts";
import {
  assembleDemoNarrative,
  assertCanonicalDemoNarrative,
} from "./demo-narrative";

describe("Demo narrative assembly", () => {
  it("orders product cards and every feature demonstration canonically", () => {
    const assembled = assembleDemoNarrative({
      draft: draft([
        browserScene("read", "read-article"),
        browserScene("register", "create-account"),
      ]),
      flowSpec: flowSpec,
      productName: "Conduit",
    }) as {
      presentation: { transitions: unknown[] };
      scenes: Array<{
        featureId?: string;
        id: string;
        text?: { content: string };
        type: string;
      }>;
    };

    expect(
      assembled.scenes.map((scene) => [scene.id, scene.type, scene.featureId]),
    ).toEqual([
      ["product-intro", "full-screen-text", undefined],
      ["feature-intro-1", "full-screen-text", undefined],
      ["register", "playwright-recording", "create-account"],
      ["feature-intro-2", "full-screen-text", undefined],
      ["read", "playwright-recording", "read-article"],
      ["product-outro", "full-screen-text", undefined],
    ]);
    expect(
      assembled.scenes.flatMap((scene) =>
        scene.text === undefined ? [] : [scene.text.content],
      ),
    ).toEqual([
      "Conduit Demo",
      "Creating an account",
      "Reading an article",
      "Conduit",
    ]);
    expect(assembled.presentation.transitions).toEqual([]);
  });

  it("rejects a final narrative without every feature introduction", () => {
    const assembled = assembleDemoNarrative({
      draft: draft([
        browserScene("register", "create-account"),
        browserScene("read", "read-article"),
      ]),
      flowSpec,
      productName: "Conduit",
    }) as { scenes: Array<{ id: string }> };
    assembled.scenes.splice(3, 1);

    expect(() =>
      assertCanonicalDemoNarrative({
        demoScript: assembled,
        flowSpec,
        productName: "Conduit",
      }),
    ).toThrow("Demo narrative must introduce feature read-article");
  });
});

const flowSpec: FlowSpec = {
  features: [
    feature("create-account", "Creating an account"),
    feature("read-article", "Reading an article"),
  ],
  id: "conduit-flow",
  repairConstraints: [],
  version: 2,
};

function feature(featureId: string, label: string) {
  return {
    expectedVisibleAssertions: ["Visible outcome"],
    featureId,
    label,
    referencedActionIds: [`${featureId}-action`],
    referencedAppMapRoutePaths: ["/"],
    requestedFeature: label.toLowerCase(),
    requiredAppState: [],
    selectionReason: "Requested by the maker",
    steps: [label],
  };
}

function browserScene(id: string, featureId: string) {
  return {
    actions: [],
    expectedVisibleOutcome: "Visible outcome",
    featureId,
    id,
    type: "playwright-recording",
  };
}

function draft(scenes: unknown[]) {
  return {
    format: "16:9",
    presentation: {
      transitions: [
        { fromSceneId: "read", style: "cut", toSceneId: "register" },
      ],
    },
    scenes,
    scriptId: "conduit-demo",
    title: "Conduit",
    version: 1,
  };
}
