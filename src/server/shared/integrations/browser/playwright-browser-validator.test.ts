import { describe, expect, it } from "vitest";

import { PlaywrightBrowserValidator } from "./playwright-browser-validator";

describe("PlaywrightBrowserValidator", () => {
  it("is an explicit stub until browser validation is implemented", async () => {
    const validator = new PlaywrightBrowserValidator();

    await expect(
      validator.validate({ url: "http://localhost:3000" }),
    ).rejects.toThrowError("PlaywrightBrowserValidator is a stub");
  });
});
