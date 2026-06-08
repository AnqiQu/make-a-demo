import { describe, expect, it } from "vitest";

import { approvedMusicTracks } from "./approved-music";

describe("approvedMusicTracks", () => {
  it("lists the approved Compositing music beds with stable selection metadata", () => {
    expect(approvedMusicTracks).toEqual([
      {
        id: "clean",
        name: "clean",
        style: "polished, warm, modern",
        suggestedUse: "SaaS walkthroughs",
      },
      {
        id: "pulse",
        name: "pulse",
        style: "energetic, futuristic, confident",
        suggestedUse: "AI automation demos",
      },
      {
        id: "focus",
        name: "focus",
        style: "calm, premium, minimal",
        suggestedUse: "Enterprise demos",
      },
      {
        id: "upbeat",
        name: "upbeat",
        style: "playful, upbeat, quirky",
        suggestedUse: "Creator tool demos",
      },
      {
        id: "vision",
        name: "vision",
        style: "cinematic, inspiring, emotional",
        suggestedUse: "Pitch videos",
      },
    ]);
  });
});
