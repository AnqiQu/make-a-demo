import type { FlowSpec } from "../schemas/artifacts";

const narrativeBackgroundColor = "#101828";
const narrativeTextColor = "#ffffff";
const backendOwnedNarrativeRule =
  "Demo Script Scenes must all be playwright-recording: the narrative intro, outro, feature cards, and transitions are backend-owned.";
const canonicalNarrativeSceneIdPattern =
  /^(?:product-intro|product-outro|feature-intro-\d+)$/;

/**
 * Produces the product-owned Demo Script narrative around agent-authored
 * browser Scenes. Implementations may rely on exact FlowSpec feature order,
 * one feature card per feature, and canonical product intro/outro cards.
 */
export function assembleDemoNarrative(input: {
  draft: unknown;
  flowSpec: FlowSpec;
  productName: string;
}): unknown {
  const draft = readRecord(input.draft, "Demo Script draft");
  if (!Array.isArray(draft.scenes)) {
    throw new Error("Demo Script draft scenes must be an array");
  }
  const productName = input.productName.trim();
  if (productName.length === 0) {
    throw new Error("Demo narrative requires a product name");
  }
  const knownFeatureIds = new Set(
    input.flowSpec.features.map((feature) => feature.featureId),
  );
  const browserScenes = draft.scenes.map((scene, index) => {
    const record = readRecord(scene, `Demo Script draft scenes[${index}]`);
    if (record.type !== "playwright-recording") {
      throw new Error(backendOwnedNarrativeRule);
    }
    if (
      typeof record.featureId !== "string" ||
      !knownFeatureIds.has(record.featureId)
    ) {
      throw new Error(
        `Demo Script browser Scene ${String(record.id)} must reference a known FlowSpec featureId`,
      );
    }
    return record;
  });
  const presentation =
    typeof draft.presentation === "object" &&
    draft.presentation !== null &&
    !Array.isArray(draft.presentation)
      ? (draft.presentation as Record<string, unknown>)
      : {};

  return {
    ...draft,
    presentation: { ...presentation, transitions: [] },
    scenes: [
      createTextScene("product-intro", `${productName} Demo`, 2),
      ...input.flowSpec.features.flatMap((feature, index) => [
        createTextScene(`feature-intro-${index + 1}`, feature.label, 1.75),
        ...browserScenes.filter(
          (scene) => scene.featureId === feature.featureId,
        ),
      ]),
      createTextScene("product-outro", productName, 2),
    ],
  };
}

/** Fails unless a final Demo Script has the backend-owned narrative order. */
export function assertCanonicalDemoNarrative(input: {
  demoScript: unknown;
  flowSpec: FlowSpec;
  productName: string;
}): void {
  const script = readRecord(input.demoScript, "Demo Script");
  if (!Array.isArray(script.scenes)) {
    throw new Error("Demo narrative Scenes must be an array");
  }
  const scenes = script.scenes.map((scene, index) =>
    readRecord(scene, `Demo narrative Scenes[${index}]`),
  );
  for (const scene of scenes) {
    if (
      scene.type !== "playwright-recording" &&
      !(
        scene.type === "full-screen-text" &&
        typeof scene.id === "string" &&
        canonicalNarrativeSceneIdPattern.test(scene.id)
      )
    ) {
      throw new Error(backendOwnedNarrativeRule);
    }
  }
  const productName = input.productName.trim();
  assertTextScene(
    scenes[0],
    "product-intro",
    `${productName} Demo`,
    "Demo narrative must begin with the product intro",
  );

  let cursor = 1;
  for (const [index, feature] of input.flowSpec.features.entries()) {
    assertTextScene(
      scenes[cursor],
      `feature-intro-${index + 1}`,
      feature.label,
      `Demo narrative must introduce feature ${feature.featureId}`,
    );
    cursor += 1;
    let featureSceneCount = 0;
    while (
      scenes[cursor]?.type === "playwright-recording" &&
      scenes[cursor]?.featureId === feature.featureId
    ) {
      featureSceneCount += 1;
      cursor += 1;
    }
    if (featureSceneCount === 0) {
      throw new Error(
        `Demo narrative must demonstrate feature ${feature.featureId} after its introduction`,
      );
    }
  }

  assertTextScene(
    scenes[cursor],
    "product-outro",
    productName,
    "Demo narrative must end with the product outro",
  );
  if (cursor !== scenes.length - 1) {
    throw new Error(
      "Demo narrative contains Scenes outside the selected features",
    );
  }
}

function createTextScene(id: string, content: string, durationSeconds: number) {
  return {
    backgroundColor: narrativeBackgroundColor,
    durationSeconds,
    id,
    text: {
      color: narrativeTextColor,
      content,
      font: "Inter",
      position: "center",
      size: "large",
    },
    type: "full-screen-text",
  };
}

function assertTextScene(
  scene: Record<string, unknown> | undefined,
  id: string,
  content: string,
  message: string,
): void {
  const text =
    scene === undefined ||
    typeof scene.text !== "object" ||
    scene.text === null ||
    Array.isArray(scene.text)
      ? undefined
      : (scene.text as Record<string, unknown>);
  if (
    scene?.type !== "full-screen-text" ||
    scene.id !== id ||
    text?.content !== content
  ) {
    throw new Error(message);
  }
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}
