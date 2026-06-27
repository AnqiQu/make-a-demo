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
  if (placeholderPatterns.some((pattern) => pattern.test(script))) {
    throw new Error("demoPlaywrightScript contains placeholder actions");
  }

  if (!meaningfulInteractionPatterns.some((pattern) => pattern.test(script))) {
    throw new Error(
      "demoPlaywrightScript must include a meaningful user interaction or feature-specific assertion",
    );
  }
}
