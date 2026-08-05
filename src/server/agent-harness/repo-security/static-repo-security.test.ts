import { describe, expect, it } from "vitest";
import { screenStaticRepoSecurity } from "./static-repo-security";

describe("screenStaticRepoSecurity", () => {
  it("accepts a standalone web app nested below a repository root", () => {
    const result = screenStaticRepoSecurity({
      files: [
        {
          path: "examples/storefront/package.json",
          text: JSON.stringify({ scripts: { dev: "vite" } }),
        },
        { path: "examples/storefront/package-lock.json", text: "{}" },
      ],
      repoStats: { fileCount: 2, sizeBytes: 200 },
    });

    expect(result).toMatchObject({ status: "passed", rejections: [] });
    expect(result.warnings).not.toContain(
      "repo has no lockfile; dependency installation may be less deterministic",
    );
  });

  it("rejects destructive lifecycle scripts in every nested package", () => {
    const result = screenStaticRepoSecurity({
      files: [
        { path: "package.json", text: "{}" },
        {
          path: "packages/worker/package.json",
          text: JSON.stringify({ scripts: { prepare: "rm -rf /" } }),
        },
        { path: "bun.lock", text: "" },
      ],
      repoStats: { fileCount: 3, sizeBytes: 300 },
    });

    expect(result.rejections).toContain(
      "package script prepare in packages/worker/package.json contains a destructive command",
    );
  });

  it("allows quarantined secret files and public certificates without exposing their contents", () => {
    const result = screenStaticRepoSecurity({
      files: [
        { path: ".env" },
        {
          path: "certificates/public.pem",
          text: "-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----",
        },
        { path: "package.json", text: "{}" },
        { path: "bun.lock", text: "" },
      ],
      repoStats: { fileCount: 4, sizeBytes: 400 },
      secretQuarantineManifest: {
        entries: [
          {
            environmentKeys: ["DATABASE_URL"],
            kind: "environment-file",
            path: ".env",
          },
        ],
        version: "2026-07-15",
      },
    });

    expect(result).toMatchObject({ status: "passed", rejections: [] });
    expect(result.warnings).toContain(
      "repo secret file .env was quarantined before agent or runtime execution",
    );
  });

  it("screens registry credentials and env-shaped content with the quarantine's own predicates", () => {
    const quarantinedResult = screenStaticRepoSecurity({
      files: [
        { path: ".npmrc" },
        { path: "config/secrets.txt" },
        { path: "package.json", text: "{}" },
        { path: "bun.lock", text: "" },
      ],
      repoStats: { fileCount: 4, sizeBytes: 400 },
      secretQuarantineManifest: {
        entries: [
          { kind: "environment-file", path: ".npmrc" },
          {
            environmentKeys: ["API_KEY", "DB_PASSWORD", "SESSION_SECRET"],
            kind: "environment-file",
            path: "config/secrets.txt",
          },
        ],
        version: "2026-07-15",
      },
    });

    expect(quarantinedResult).toMatchObject({
      rejections: [],
      status: "passed",
    });
    expect(quarantinedResult.warnings).toContain(
      "repo secret file .npmrc was quarantined before agent or runtime execution",
    );
    expect(quarantinedResult.warnings).toContain(
      "repo secret file config/secrets.txt was quarantined before agent or runtime execution",
    );

    const unquarantinedResult = screenStaticRepoSecurity({
      files: [
        {
          path: ".npmrc",
          text: "//registry.npmjs.org/:_authToken=npm_token_abc123",
        },
        {
          path: "config/secrets.txt",
          text: "API_KEY=sk_live_123\nDB_PASSWORD=hunter2\nSESSION_SECRET=abc123",
        },
        { path: "package.json", text: "{}" },
        { path: "bun.lock", text: "" },
      ],
      repoStats: { fileCount: 4, sizeBytes: 400 },
    });

    expect(unquarantinedResult.status).toBe("rejected");
    expect(unquarantinedResult.rejections).toContain(
      "repo contains committed secret file .npmrc",
    );
    expect(unquarantinedResult.rejections).toContain(
      "repo contains committed secret file config/secrets.txt",
    );
  });

  it("anchors destructive-script detection to root deletion and real mkfs invocations", () => {
    const legitimate = screenStaticRepoSecurity({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            scripts: {
              clean: "rm -rf /tmp/makeademo-cache && rm -rf ./dist",
              docs: "node scripts/mkfsdocs.js",
            },
          }),
        },
        { path: "bun.lock", text: "" },
      ],
      repoStats: { fileCount: 2, sizeBytes: 200 },
    });

    expect(legitimate).toMatchObject({ rejections: [], status: "passed" });

    const destructive = screenStaticRepoSecurity({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            scripts: { format: "mkfs.ext4 /dev/sda1", nuke: "rm -fr /" },
          }),
        },
        { path: "bun.lock", text: "" },
      ],
      repoStats: { fileCount: 2, sizeBytes: 200 },
    });

    expect(destructive.status).toBe("rejected");
    expect(destructive.rejections).toEqual(
      expect.arrayContaining([
        "package script format contains a destructive command",
        "package script nuke contains a destructive command",
      ]),
    );
  });

  it("rejects an unscanned package manifest and surfaces other unscanned files", () => {
    const result = screenStaticRepoSecurity({
      files: [
        { path: "package.json", scanned: false },
        { path: "docs/NOTES.md", scanned: false },
        { path: "bun.lock", text: "" },
      ],
      repoStats: { fileCount: 3, sizeBytes: 3_000_000 },
    });

    expect(result.status).toBe("rejected");
    expect(result.rejections).toContain(
      "package.json is too large to screen for destructive scripts",
    );
    expect(result.warnings).toContain(
      "repo file docs/NOTES.md was too large to screen for secrets",
    );
  });

  it("only treats real environment filenames as secrets and matches template suffixes case-insensitively", () => {
    const result = screenStaticRepoSecurity({
      files: [
        { path: ".environment", text: "not an env-file convention" },
        { path: ".env.EXAMPLE", text: "DATABASE_URL=" },
        { path: "package.json", text: "{}" },
        { path: "bun.lock", text: "" },
      ],
      repoStats: { fileCount: 4, sizeBytes: 200 },
    });

    expect(result).toMatchObject({ status: "passed", rejections: [] });
  });

  it("rejects missing package metadata, committed secrets, private keys, and destructive scripts", () => {
    expect(
      screenStaticRepoSecurity({
        files: [
          { path: ".env", text: "OPENAI_API_KEY=sk-test" },
          { path: "id_rsa", text: "-----BEGIN OPENSSH PRIVATE KEY-----" },
        ],
        repoStats: { fileCount: 2, sizeBytes: 200 },
      }),
    ).toMatchObject({
      status: "rejected",
      rejections: expect.arrayContaining([
        "package.json is required for JavaScript/TypeScript repos",
        "repo contains committed secret file .env",
        "repo contains private key material in id_rsa",
      ]),
    });

    expect(
      screenStaticRepoSecurity({
        files: [
          {
            path: "package.json",
            text: JSON.stringify({ scripts: { clean: "rm -rf /" } }),
          },
          { path: "bun.lock", text: "" },
        ],
        repoStats: { fileCount: 2, sizeBytes: 200 },
      }),
    ).toMatchObject({
      status: "rejected",
      rejections: ["package script clean contains a destructive command"],
    });
  });

  it("warns about dependency and runtime risks without executing submitted code", () => {
    const result = screenStaticRepoSecurity({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            dependencies: { "@auth/core": "latest", stripe: "latest" },
            scripts: { postinstall: "node setup.js" },
          }),
        },
        { path: "Dockerfile", text: "FROM node\nRUN sudo apt update\n" },
        { path: "pnpm-lock.yaml", text: "" },
      ],
      repoStats: { fileCount: 3, sizeBytes: 300 },
    });

    expect(result.status).toBe("passed");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "package script postinstall may run setup code during dependency installation",
        "auth package @auth/core may require local demo bypass or mocks",
        "external service package stripe may require local mocks",
        "Dockerfile requests privileged operations",
      ]),
    );
  });

  it("rejects dedicated private-key containers but not ambiguous PEM files without private-key content", () => {
    const result = screenStaticRepoSecurity({
      files: [
        { path: "package.json", text: "{}" },
        { path: "bun.lock", text: "" },
        { path: "certs/client.pem" },
        { path: "certs/client.key" },
        { path: "certs/signing.p12" },
        { path: "certs/signing.pfx" },
      ],
      repoStats: { fileCount: 6, sizeBytes: 1_024 },
    });

    expect(result.rejections).toEqual(
      expect.arrayContaining([
        "repo contains private key material in certs/client.key",
        "repo contains private key material in certs/signing.p12",
        "repo contains private key material in certs/signing.pfx",
      ]),
    );
    expect(result.rejections).not.toContain(
      "repo contains private key material in certs/client.pem",
    );
  });

  it("rejects symlinks that can escape the screened repository", () => {
    const result = screenStaticRepoSecurity({
      files: [
        { path: "package.json", text: "{}" },
        { path: "bun.lock", text: "" },
        { path: "src/current.ts", symlinkTarget: "./versions/current.ts" },
        { path: "src/environment", symlinkTarget: "/proc/self/environ" },
        { path: "src/parent", symlinkTarget: "../../outside" },
        { path: "src/nested/sibling", symlinkTarget: "../lib/util.ts" },
      ],
      repoStats: { fileCount: 6, sizeBytes: 600 },
    });

    expect(result.rejections).toEqual(
      expect.arrayContaining([
        "repo symlink src/environment escapes the repository",
        "repo symlink src/parent escapes the repository",
      ]),
    );
    expect(result.rejections).not.toContain(
      "repo symlink src/current.ts escapes the repository",
    );
    expect(result.rejections).not.toContain(
      "repo symlink src/nested/sibling escapes the repository",
    );
  });

  it("accepts upward relative symlinks that resolve inside the repository", () => {
    const result = screenStaticRepoSecurity({
      files: [
        { path: "package.json", text: "{}" },
        { path: "bun.lock", text: "" },
        { path: ".agents/skills/commit/SKILL.md", text: "" },
        { path: "agents/rules/README.md", text: "" },
        {
          path: ".claude/skills/commit",
          symlinkTarget: "../../.agents/skills/commit",
        },
        { path: ".claude/rules", symlinkTarget: "../agents/rules" },
      ],
      repoStats: { fileCount: 6, sizeBytes: 600 },
    });

    expect(result.rejections).toEqual([]);
  });

  it("rejects symlinks that escape through another symlink in the chain", () => {
    const result = screenStaticRepoSecurity({
      files: [
        { path: "package.json", text: "{}" },
        { path: "bun.lock", text: "" },
        { path: "docs/etc-alias", symlinkTarget: "/etc" },
        { path: "docs/link", symlinkTarget: "etc-alias/../passwd" },
        { path: "up-alias", symlinkTarget: "vendor/up/target" },
        { path: "vendor/up", symlinkTarget: "../.." },
      ],
      repoStats: { fileCount: 6, sizeBytes: 600 },
    });

    expect(result.rejections).toEqual(
      expect.arrayContaining([
        "repo symlink docs/etc-alias escapes the repository",
        "repo symlink docs/link escapes the repository",
        "repo symlink up-alias escapes the repository",
        "repo symlink vendor/up escapes the repository",
      ]),
    );
  });

  it("rejects symlink cycles as unresolvable", () => {
    const result = screenStaticRepoSecurity({
      files: [
        { path: "package.json", text: "{}" },
        { path: "bun.lock", text: "" },
        { path: "a", symlinkTarget: "b" },
        { path: "b", symlinkTarget: "a" },
      ],
      repoStats: { fileCount: 4, sizeBytes: 400 },
    });

    expect(result.rejections).toEqual(
      expect.arrayContaining([
        "repo symlink a escapes the repository",
        "repo symlink b escapes the repository",
      ]),
    );
  });
});
