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

  it("allows an empty feature list so the pipeline can select explored features", () => {
    expect(readDemoBrief({ keyProductFeatures: [] })).toEqual({
      keyProductFeatures: [],
    });
  });

  it("accepts a repo-relative browser application override", () => {
    expect(
      readDemoBrief({
        keyProductFeatures: [],
        preferredAppDir: "apps/dashboard",
      }),
    ).toEqual({
      keyProductFeatures: [],
      preferredAppDir: "apps/dashboard",
    });
    expect(() =>
      readDemoBrief({ keyProductFeatures: [], preferredAppDir: "../outside" }),
    ).toThrow(/preferredAppDir/);
  });
});
