import type { CaptureReadyVideoScriptPackage } from "../06-capture/video-script-package.schema";

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
  /toContainText\s*\(\s*\/\\S\//,
];

export function assertCaptureReadyScriptQuality(
  scriptPackage: CaptureReadyVideoScriptPackage,
): void {
  for (const [sectionIndex, section] of scriptPackage.sections.entries()) {
    for (const [sceneIndex, scene] of section.scenes.entries()) {
      if (scene.type !== "playwright-recording") {
        continue;
      }

      const path = `sections[${sectionIndex}].scenes[${sceneIndex}]`;
      const script = scene.playwrightScript;
      if (placeholderPatterns.some((pattern) => pattern.test(script))) {
        throw new Error(
          `${path}.playwrightScript contains placeholder actions`,
        );
      }

      if (
        !meaningfulInteractionPatterns.some((pattern) => pattern.test(script))
      ) {
        throw new Error(
          `${path}.playwrightScript must include a meaningful user interaction or feature-specific assertion`,
        );
      }
    }
  }
}
