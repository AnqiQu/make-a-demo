import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { DefaultCapturePathSceneValidator } from "./playwright-capture-path-scene-validator";

describe("DefaultCapturePathSceneValidator", () => {
  it("persists stdout and stderr when a dry-run scene fails", async () => {
    const validator = new DefaultCapturePathSceneValidator();

    const result = await validator.validateScene({
      baseUrl: "https://example.test/",
      scene: {
        durationSeconds: 1,
        events: ["Throw an error"],
        humanReadableDescription: "Fail deterministically.",
        id: "scene_failure_evidence",
        playwrightScript: 'throw new Error("selector exploded");',
      },
      sectionId: "section_failure",
    });

    expect(result.status).toBe("failed");
    expect(result.stdoutPath).toContain("scene_failure_evidence.stdout.log");
    expect(result.stderrPath).toContain("scene_failure_evidence.stderr.log");
    expect(await readFile(result.stdoutPath as string, "utf8")).toBe("");
    expect(await readFile(result.stderrPath as string, "utf8")).toContain(
      "selector exploded",
    );
    expect(result.logs.join("\n")).toContain("selector exploded");
  });
});
