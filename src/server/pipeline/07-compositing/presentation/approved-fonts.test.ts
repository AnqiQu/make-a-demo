import { describe, expect, it } from "vitest";

import { approvedFonts } from "./approved-fonts";

describe("approvedFonts", () => {
  it("lists the approved Compositing fonts with stable selection metadata", () => {
    expect(approvedFonts).toEqual([
      {
        font: "Inter",
        id: "inter",
        style: "Clean modern sans",
        suggestedUse: "Default SaaS and UI demos",
      },
      {
        font: "Space Grotesk",
        id: "space-grotesk",
        style: "Techy grotesk",
        suggestedUse: "AI, devtool, and infrastructure demos",
      },
      {
        font: "IBM Plex Sans",
        id: "ibm-plex-sans",
        style: "Professional, slightly technical sans",
        suggestedUse: "Enterprise and productivity demos",
      },
      {
        font: "Nunito",
        id: "nunito",
        style: "Rounded geometric sans",
        suggestedUse: "Polished consumer and startup demos",
      },
      {
        font: "Bricolage Grotesque",
        id: "bricolage-grotesque",
        style: "Quirky expressive sans",
        suggestedUse: "Playful creator-style videos",
      },
      {
        font: "Fraunces",
        id: "fraunces",
        style: "Soft expressive serif",
        suggestedUse: "Premium and editorial title cards",
      },
      {
        font: "Playfair Display",
        id: "playfair-display",
        style: "Elegant high-contrast serif",
        suggestedUse: "Luxury, fashion, and personal brand demos",
      },
      {
        font: "JetBrains Mono",
        id: "jetbrains-mono",
        style: "Developer-friendly monospace",
        suggestedUse: "Code, terminal, and developer demos",
      },
    ]);
  });
});
