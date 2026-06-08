import { describe, expect, it } from "vitest";

import { finalVideoEmailsEnabled } from "./final-video-email-feature";

describe("finalVideoEmailsEnabled", () => {
  it("keeps final video emails off unless explicitly enabled", () => {
    expect(finalVideoEmailsEnabled({})).toBe(false);
    expect(
      finalVideoEmailsEnabled({ FINAL_VIDEO_EMAILS_ENABLED: "false" }),
    ).toBe(false);
    expect(finalVideoEmailsEnabled({ FINAL_VIDEO_EMAILS_ENABLED: "0" })).toBe(
      false,
    );
  });

  it("enables final video emails when the feature flag is true", () => {
    expect(
      finalVideoEmailsEnabled({ FINAL_VIDEO_EMAILS_ENABLED: "true" }),
    ).toBe(true);
    expect(finalVideoEmailsEnabled({ FINAL_VIDEO_EMAILS_ENABLED: "1" })).toBe(
      true,
    );
  });
});
