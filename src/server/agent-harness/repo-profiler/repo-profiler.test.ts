import { describe, expect, it } from "vitest";
import { profileRepo } from "./repo-profiler";

describe("profileRepo", () => {
  it("derives a deterministic RepoProfile from package metadata and repo files", () => {
    const profile = profileRepo({
      commitSha: "abc123",
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            dependencies: {
              "@clerk/nextjs": "latest",
              next: "latest",
              stripe: "latest",
            },
            scripts: {
              build: "next build",
              dev: "next dev --port 3000",
              postinstall: "node scripts/setup.js",
            },
            workspaces: ["apps/*"],
          }),
        },
        { path: "pnpm-lock.yaml", text: "" },
        {
          path: ".env.example",
          text: "DATABASE_URL=\nNEXT_PUBLIC_FLAG=true\n",
        },
        { path: "apps/web/package.json", text: "{}" },
        { path: "Dockerfile", text: "FROM node:22\n" },
      ],
      repoUrl: "https://github.com/example/app",
      rootDir: "/workspace",
    });

    expect(profile).toMatchObject({
      authHints: ["@clerk/nextjs"],
      candidateAppDirs: [".", "apps/web"],
      candidateBuildCommands: ["pnpm build"],
      candidateInstallCommands: ["pnpm install --frozen-lockfile"],
      candidatePorts: [3000],
      candidateStartCommands: ["pnpm dev --port 3000"],
      commitSha: "abc123",
      detectedFrameworks: ["next"],
      dockerHints: ["Dockerfile"],
      externalServiceHints: ["stripe"],
      lockfiles: ["pnpm-lock.yaml"],
      packageManager: "pnpm",
      requiredEnvHints: ["DATABASE_URL", "NEXT_PUBLIC_FLAG"],
      rootDir: "/workspace",
      securityWarnings: ["package script postinstall runs during install"],
      workspaces: { isMonorepo: true, packageDirectories: ["apps/*"] },
    });
    expect(profile.confidence.overall).toBeGreaterThan(0.7);
  });
});
