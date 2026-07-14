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

  it("uses executable npm script commands and forwards detected ports", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            scripts: { build: "vite build", dev: "vite --port 4173" },
          }),
        },
        { path: "package-lock.json", text: "" },
      ],
      repoUrl: "https://github.com/example/npm-app",
    });

    expect(profile.candidateBuildCommands).toEqual(["npm run build"]);
    expect(profile.candidateStartCommands).toEqual([
      "npm run dev -- --port 4173",
    ]);
  });

  it("profiles executable workspace scripts and their ports", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            scripts: { "dev:web": "turbo dev --filter=@acme/web" },
            workspaces: ["apps/*"],
          }),
        },
        {
          path: "apps/web/package.json",
          text: JSON.stringify({
            name: "@acme/web",
            scripts: { build: "next build", dev: "next dev -p 3100" },
          }),
        },
        { path: "bun.lock", text: "" },
      ],
      repoUrl: "https://github.com/example/workspace",
    });

    expect(profile.workspacePackages).toEqual([
      {
        dir: "apps/web",
        name: "@acme/web",
        ports: [3100],
        scripts: { build: "next build", dev: "next dev -p 3100" },
      },
    ]);
  });
});
