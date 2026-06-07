import { describe, expect, it } from "vitest";

import { readDemoBrief, readProjectIntake } from "./project-intake";

describe("Context Gathering intake", () => {
  it("captures the submitted repo URL for validation", () => {
    expect(
      readProjectIntake({ repoUrl: "https://github.com/milo/makeademo-demo" }),
    ).toEqual({ repoUrl: "https://github.com/milo/makeademo-demo" });
  });

  it("captures the later Demo Brief for Script Generation", () => {
    expect(
      readDemoBrief({
        audience: "hackathon judges",
        keyProductFeatures: ["repo validation", "script planning"],
      }),
    ).toEqual({
      audience: "hackathon judges",
      keyProductFeatures: ["repo validation", "script planning"],
    });
  });
});
