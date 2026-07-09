const invalidMessage =
  "GitHub repo URL must be a canonical, credential-free https://github.com/owner/repo URL.";

export function assertSafeGithubRepoUrl(repoUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new Error(invalidMessage);
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parts.length !== 2 ||
    parts.some((part) => part === "." || part === "..")
  ) {
    throw new Error(invalidMessage);
  }
}
