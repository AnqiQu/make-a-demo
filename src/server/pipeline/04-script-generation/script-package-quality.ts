import type { DemoScript } from "../06-footage-capture/demo-script.schema";

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
  const script = demoScript.demoPlaywrightScript;
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
      !isBodyOnlySmokeCheck(sceneBody)
    ) {
      return true;
    }
  }

  return false;
}

function isBodyOnlySmokeCheck(script: string): boolean {
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
