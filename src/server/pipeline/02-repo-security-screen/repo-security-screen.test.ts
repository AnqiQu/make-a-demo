import { describe, expect, it } from "vitest";

import { screenRepoSecurity } from "./repo-security-screen";

describe("screenRepoSecurity", () => {
  it("rejects repos with obvious static safety failures", () => {
    const result = screenRepoSecurity({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ scripts: { demo: "rm -rf /" } }),
        },
        { path: ".env", text: "API_KEY=secret" },
      ],
      repoStats: { fileCount: 10, sizeBytes: 100_000 },
    });

    expect(result.status).toBe("rejected");
    expect(result.rejections).toContain(
      "package script demo contains a destructive command",
    );
    expect(result.rejections).toContain(
      "repo contains committed secret file .env",
    );
  });

  it("rejects secret-looking files committed outside the repo root", () => {
    const result = screenRepoSecurity({
      files: [
        { path: "package.json", text: JSON.stringify({}) },
        { path: "apps/web/.env.production", text: "API_KEY=secret" },
        { path: "config/id_ed25519", text: "private-key" },
      ],
      repoStats: { fileCount: 10, sizeBytes: 100_000 },
    });

    expect(result.status).toBe("rejected");
    expect(result.rejections).toContain(
      "repo contains committed secret file apps/web/.env.production",
    );
    expect(result.rejections).toContain(
      "repo contains committed secret file config/id_ed25519",
    );
  });

  it("rejects common private-key file extensions", () => {
    const result = screenRepoSecurity({
      files: [
        { path: "package.json", text: JSON.stringify({}) },
        { path: "certificates/signing.pem" },
        { path: "config/service-account.KEY" },
      ],
      repoStats: { fileCount: 3, sizeBytes: 1_000 },
    });

    expect(result.status).toBe("rejected");
    expect(result.rejections).toContain(
      "repo contains committed secret file certificates/signing.pem",
    );
    expect(result.rejections).toContain(
      "repo contains committed secret file config/service-account.KEY",
    );
  });

  it("warns for large repos and non-fatal preparation risks", () => {
    const result = screenRepoSecurity({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            dependencies: { "@clerk/clerk-react": "latest" },
            scripts: { postinstall: "node setup.js" },
          }),
        },
      ],
      repoStats: { fileCount: 25_000, sizeBytes: 600_000_000 },
    });

    expect(result.status).toBe("passed");
    expect(result.warnings).toContain(
      "repo size or file count may degrade agent exploration quality",
    );
    expect(result.warnings).toContain(
      "repo has no lockfile; dependency installation may be less deterministic",
    );
    expect(result.warnings).toContain(
      "package script postinstall may run setup code during dependency installation",
    );
    expect(result.warnings).toContain(
      "auth package @clerk/clerk-react may require local demo bypass or mocks",
    );
  });
});
