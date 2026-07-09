import { describe, expect, it } from "vitest";
import { assertSafeGithubRepoUrl } from "./github-repo-url";

describe("assertSafeGithubRepoUrl", () => {
  it("accepts only canonical credential-free GitHub repository URLs", () => {
    expect(() =>
      assertSafeGithubRepoUrl("https://github.com/acme/calendar"),
    ).not.toThrow();
    expect(() =>
      assertSafeGithubRepoUrl("https://github.com/acme/calendar.git"),
    ).not.toThrow();

    for (const url of [
      "https://token@github.com/acme/calendar",
      "https://github.com/acme/calendar/tree/main",
      "https://github.com/acme/calendar?token=secret",
      "http://github.com/acme/calendar",
      "https://github.example.com/acme/calendar",
    ]) {
      expect(() => assertSafeGithubRepoUrl(url), url).toThrow(
        "credential-free https://github.com/owner/repo URL",
      );
    }
  });
});
