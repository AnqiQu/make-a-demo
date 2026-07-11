import type { DemoScript } from "../../pipeline/06-footage-capture/demo-script.schema";

const meaningfulInteractionPatterns = [
  /\.click\s*\(/,
  /\.fill\s*\(/,
  /\.press\s*\(/,
  /\.selectOption\s*\(/,
  /page\.goto\s*\(\s*baseUrl\s*\+/,
  /expect\s*\([^)]*(?:text|role|label|placeholder|title|testid|getBy|locator)/i,
];

const placeholderPatterns = [
  /document\.body\.setAttribute\s*\(\s*['"]data-makeademo-feature['"]/,
  /expect\s*\(\s*page\.locator\(\s*['"]body['"]\s*\)\s*\)\.toBeVisible\s*\(\s*\)/,
  /toContainText\s*\(\s*\/\\S\//,
];

export function assertCaptureReadyScriptQuality(demoScript: DemoScript): void {
  const browserScenes = demoScript.scenes.filter(
    (scene) => scene.type === "playwright-recording",
  );
  if (browserScenes.length === 0) {
    return;
  }
  const script = demoScript.demoPlaywrightScript;
  if (script === undefined) {
    throw new Error(
      "Demo Script with browser Scenes must include compiled Playwright source",
    );
  }
  const hasMeaningfulInteraction = meaningfulInteractionPatterns.some(
    (pattern) => pattern.test(script),
  );
  if (!hasMeaningfulInteraction) {
    throw new Error(
      "demoPlaywrightScript must include a meaningful user interaction or feature-specific assertion",
    );
  }

  if (
    placeholderPatterns.some((pattern) => pattern.test(script)) &&
    !hasFeatureSpecificSceneBehavior(script)
  ) {
    throw new Error("demoPlaywrightScript contains placeholder actions");
  }

  for (const scene of browserScenes) {
    const sceneBody = readSceneCallbackSource(script, scene.id);
    if (sceneBody !== undefined && isPlaceholderSceneBody(sceneBody)) {
      throw new Error(`Scene ${scene.id} contains placeholder actions`);
    }
  }
}

function hasFeatureSpecificSceneBehavior(script: string): boolean {
  const sceneBlocks = script.matchAll(
    /scene\s*\(\s*['"][^'"]+['"]\s*,\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\}\s*\)/g,
  );

  for (const [, sceneBody] of sceneBlocks) {
    if (
      sceneBody !== undefined &&
      meaningfulInteractionPatterns.some((pattern) =>
        pattern.test(sceneBody),
      ) &&
      !isBodyOnlyVisibilityCheck(sceneBody)
    ) {
      return true;
    }
  }

  return false;
}

function isBodyOnlyVisibilityCheck(script: string): boolean {
  return (
    /expect\s*\(\s*page\.locator\(\s*['"]body['"]\s*\)\s*\)\.toBeVisible\s*\(\s*\)/.test(
      script,
    ) &&
    !/\.click\s*\(|\.fill\s*\(|\.press\s*\(|\.selectOption\s*\(|locator\(\s*['"]#/.test(
      script.replace(
        /expect\s*\(\s*page\.locator\(\s*['"]body['"]\s*\)\s*\)\.toBeVisible\s*\(\s*\)/g,
        "",
      ),
    )
  );
}

function isPlaceholderSceneBody(script: string): boolean {
  if (isBodyOnlyVisibilityCheck(script)) {
    return true;
  }

  return (
    placeholderPatterns.some((pattern) => pattern.test(script)) &&
    !hasMeaningfulSceneBehavior(script)
  );
}

function hasMeaningfulSceneBehavior(script: string): boolean {
  return (
    meaningfulInteractionPatterns.some((pattern) => pattern.test(script)) &&
    !isBodyOnlyVisibilityCheck(script)
  );
}

function readSceneCallbackSource(
  script: string,
  sceneId: string,
): string | undefined {
  const marker = new RegExp(`scene\\(\\s*['"]${escapeRegExp(sceneId)}['"]`);
  const match = marker.exec(script);
  if (match === null) {
    return undefined;
  }

  const nextSceneIndex = script
    .slice(match.index + match[0].length)
    .search(/\bscene\s*\(/);
  if (nextSceneIndex === -1) {
    return script.slice(match.index);
  }

  return script.slice(
    match.index,
    match.index + match[0].length + nextSceneIndex,
  );
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
