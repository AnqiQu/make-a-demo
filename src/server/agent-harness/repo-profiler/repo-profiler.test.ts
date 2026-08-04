import { describe, expect, it } from "vitest";
import { profileRepo } from "./repo-profiler";

describe("profileRepo", () => {
  it("profiles a nested standalone app from its own package and lockfile", () => {
    const profile = profileRepo({
      files: [
        { path: "README.md", text: "Examples" },
        {
          path: "examples/storefront/package.json",
          text: JSON.stringify({
            dependencies: { vite: "latest" },
            name: "storefront",
            scripts: { build: "vite build", dev: "vite --port 4173" },
          }),
        },
        { path: "examples/storefront/package-lock.json", text: "{}" },
        {
          path: "examples/storefront/.env.example",
          text: "PUBLIC_API_ORIGIN=\n",
        },
      ],
      repoUrl: "https://github.com/example/examples",
    });

    expect(profile).toMatchObject({
      candidateAppDirs: ["examples/storefront"],
      candidateBuildCommands: ["npm run build"],
      candidateInstallCommands: ["npm ci --no-audit"],
      candidatePorts: [4173],
      candidateStartCommands: ["npm run dev -- --port 4173"],
      envExamples: ["examples/storefront/.env.example"],
      lockfiles: ["examples/storefront/package-lock.json"],
      packageManager: "npm",
      requiredEnvHints: ["PUBLIC_API_ORIGIN"],
      workspacePackages: [
        {
          dir: "examples/storefront",
          installDir: "examples/storefront",
          isWorkspace: false,
          name: "storefront",
          packageManager: "npm",
          ports: [4173],
          scripts: { build: "vite build", dev: "vite --port 4173" },
        },
      ],
      workspaces: { isMonorepo: false, packageDirectories: [] },
    });
    expect(profile.confidence.overall).toBe(1);
  });

  it("keeps a browser candidate whose component evidence lives outside conventional directories", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ workspaces: ["apps/*"] }),
        },
        { path: "bun.lock", text: "" },
        {
          path: "apps/web/package.json",
          text: JSON.stringify({
            dependencies: { next: "15.0.0" },
            name: "@acme/web",
            scripts: { dev: "next dev" },
          }),
        },
        {
          path: "apps/web/lib/dashboard-page.tsx",
          text: "export const DashboardPage = () => null;",
        },
      ],
      repoUrl: "https://github.com/example/unconventional-layout",
    });

    expect(profile.browserRuntimeCandidates).toMatchObject([
      {
        dir: "apps/web",
        evidencePaths: [
          "apps/web/package.json",
          "apps/web/lib/dashboard-page.tsx",
        ],
        frameworks: ["next"],
      },
    ]);
  });

  it("prefers the explicit packageManager declaration over a stale lockfile", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            packageManager: "pnpm@9.0.0",
            scripts: { dev: "vite" },
          }),
        },
        { path: "package-lock.json", text: "{}" },
      ],
      repoUrl: "https://github.com/example/stale-lockfile",
    });

    expect(profile.packageManager).toBe("pnpm");
    expect(profile.candidateInstallCommands).toEqual([
      "pnpm install --frozen-lockfile",
    ]);
  });

  it("records an assumption when conflicting lockfiles force a manager tiebreak", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ scripts: { dev: "vite" } }),
        },
        { path: "package-lock.json", text: "{}" },
        { path: "pnpm-lock.yaml", text: "" },
      ],
      repoUrl: "https://github.com/example/conflicting-lockfiles",
    });

    expect(profile.packageManager).toBe("pnpm");
    expect(profile.confidence.assumptions).toContain(
      "conflicting lockfiles (package-lock.json, pnpm-lock.yaml) resolved to pnpm by manager preference",
    );
  });

  it("resolves a workspace member through the nearest ancestor declaration when lockfiles conflict", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            packageManager: "yarn@4.0.0",
            workspaces: ["apps/*"],
          }),
        },
        { path: "package-lock.json", text: "{}" },
        { path: "yarn.lock", text: "" },
        {
          path: "apps/web/package.json",
          text: JSON.stringify({
            dependencies: { vite: "5.0.0" },
            name: "web",
            scripts: { dev: "vite" },
          }),
        },
        { path: "apps/web/src/main.tsx", text: "export {};" },
      ],
      repoUrl: "https://github.com/example/ancestor-declaration",
    });

    expect(
      profile.workspacePackages?.find(({ dir }) => dir === "apps/web")
        ?.packageManager,
    ).toBe("yarn");
  });

  it("detects a monorepo from zero-indent pnpm workspace YAML", () => {
    const profile = profileRepo({
      files: [
        { path: "package.json", text: JSON.stringify({ name: "root" }) },
        { path: "pnpm-lock.yaml", text: "" },
        { path: "pnpm-workspace.yaml", text: 'packages:\n- "apps/*"\n' },
        {
          path: "apps/web/package.json",
          text: JSON.stringify({ name: "web", scripts: { dev: "vite" } }),
        },
        { path: "apps/web/src/main.tsx", text: "export {};" },
      ],
      repoUrl: "https://github.com/example/zero-indent",
    });

    expect(profile.workspaces).toEqual({
      isMonorepo: true,
      packageDirectories: ["apps/*"],
    });
    expect(
      profile.workspacePackages?.find(({ dir }) => dir === "apps/web")
        ?.isWorkspace,
    ).toBe(true);
  });

  it("matches workspace members through brace globs", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ workspaces: ["apps/{web,admin}"] }),
        },
        { path: "bun.lock", text: "" },
        {
          path: "apps/web/package.json",
          text: JSON.stringify({ name: "web", scripts: { dev: "vite" } }),
        },
        { path: "apps/web/src/main.tsx", text: "export {};" },
        {
          path: "apps/docs/package.json",
          text: JSON.stringify({ name: "docs", scripts: { dev: "vite" } }),
        },
        { path: "apps/docs/src/main.tsx", text: "export {};" },
      ],
      repoUrl: "https://github.com/example/brace-globs",
    });

    const byDir = new Map(
      (profile.workspacePackages ?? []).map((entry) => [entry.dir, entry]),
    );
    expect(byDir.get("apps/web")?.isWorkspace).toBe(true);
    expect(byDir.get("apps/docs")?.isWorkspace).toBe(false);
  });

  it("detects a monorepo from lerna.json packages", () => {
    const profile = profileRepo({
      files: [
        { path: "package.json", text: JSON.stringify({ name: "root" }) },
        { path: "package-lock.json", text: "{}" },
        {
          path: "lerna.json",
          text: JSON.stringify({ packages: ["packages/*"] }),
        },
        {
          path: "packages/web/package.json",
          text: JSON.stringify({ name: "web", scripts: { dev: "vite" } }),
        },
        { path: "packages/web/src/main.tsx", text: "export {};" },
      ],
      repoUrl: "https://github.com/example/lerna",
    });

    expect(profile.workspaces).toEqual({
      isMonorepo: true,
      packageDirectories: ["packages/*"],
    });
  });

  it("retains quarantined environment key names without retaining their values", () => {
    const profile = profileRepo({
      files: [
        { path: ".env" },
        {
          path: "package.json",
          text: JSON.stringify({ scripts: { dev: "vite" } }),
        },
        { path: "bun.lock", text: "" },
      ],
      quarantinedEnvironmentKeys: ["DATABASE_URL", "OPENAI_API_KEY"],
      repoUrl: "https://github.com/example/quarantined-env",
    });

    expect(profile.requiredEnvHints).toEqual([
      "DATABASE_URL",
      "OPENAI_API_KEY",
    ]);
  });

  it("reads env hint keys from every env-family example file with the shared extractor", () => {
    const profile = profileRepo({
      files: [
        {
          path: "config/prod.env.example",
          text: "export DATABASE_URL=postgres://localhost/db\nStripe_Key=sk_test_123\nAPI_KEY=value",
        },
        {
          path: "package.json",
          text: JSON.stringify({ scripts: { dev: "vite" } }),
        },
        { path: "bun.lock", text: "" },
      ],
      repoUrl: "https://github.com/example/env-family",
    });

    expect(profile.requiredEnvHints).toEqual([
      "API_KEY",
      "DATABASE_URL",
      "Stripe_Key",
    ]);
  });

  it("records the root package name so scoped installs can include root dependencies", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            dependencies: { "use-stick-to-bottom": "^1.0.0" },
            name: "midday",
            workspaces: ["apps/*"],
          }),
        },
        { path: "bun.lock", text: "" },
        {
          path: "apps/web/package.json",
          text: JSON.stringify({
            name: "@midday/web",
            scripts: { dev: "next dev" },
          }),
        },
      ],
      repoUrl: "https://github.com/example/app",
    });

    expect(profile.rootPackageName).toBe("midday");
  });

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
      candidateBuildCommands: ["pnpm run build"],
      candidateInstallCommands: ["pnpm install --frozen-lockfile"],
      candidatePorts: [3000],
      candidateStartCommands: ["pnpm run dev --port 3000"],
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
        installDir: ".",
        isWorkspace: true,
        name: "@acme/web",
        packageManager: "bun",
        ports: [3100],
        scripts: { build: "next build", dev: "next dev -p 3100" },
      },
    ]);
  });

  it("identifies runnable browser workspaces without treating orchestrators or services as apps", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            dependencies: { next: "latest", react: "latest" },
            devDependencies: { turbo: "latest" },
            scripts: { dev: "turbo dev --parallel" },
            workspaces: ["apps/*", "packages/*"],
          }),
        },
        {
          path: "apps/site/package.json",
          text: JSON.stringify({
            dependencies: { next: "latest", react: "latest" },
            name: "@acme/site",
            scripts: { dev: "next dev -p 3000" },
          }),
        },
        { path: "apps/site/src/app/page.tsx", text: "export default Page" },
        {
          path: "apps/operations/package.json",
          text: JSON.stringify({
            dependencies: { next: "latest", react: "latest" },
            name: "@acme/operations",
            scripts: { dev: "next dev -p 3001" },
          }),
        },
        {
          path: "apps/operations/src/app/page.tsx",
          text: "export default Page",
        },
        {
          path: "apps/api/package.json",
          text: JSON.stringify({
            name: "@acme/api",
            scripts: { dev: "bun --hot src/index.ts" },
          }),
        },
        { path: "apps/api/src/index.ts", text: "export const api = true" },
        {
          path: "packages/ui/package.json",
          text: JSON.stringify({
            dependencies: { react: "latest" },
            name: "@acme/ui",
          }),
        },
        { path: "bun.lock", text: "" },
      ],
      repoUrl: "https://github.com/example/multi-app",
    });

    expect(profile.browserRuntimeCandidates).toEqual([
      {
        dir: "apps/site",
        evidencePaths: ["apps/site/package.json", "apps/site/src/app/page.tsx"],
        frameworks: ["next", "react"],
        installDir: ".",
        isWorkspace: true,
        name: "@acme/site",
        packageManager: "bun",
        ports: [3000],
        scripts: { dev: "next dev -p 3000" },
      },
      {
        dir: "apps/operations",
        evidencePaths: [
          "apps/operations/package.json",
          "apps/operations/src/app/page.tsx",
        ],
        frameworks: ["next", "react"],
        installDir: ".",
        isWorkspace: true,
        name: "@acme/operations",
        packageManager: "bun",
        ports: [3001],
        scripts: { dev: "next dev -p 3001" },
      },
    ]);
  });

  it("recognizes browser frameworks from package scripts when dependencies are hoisted", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            dependencies: { "@angular/core": "latest" },
            workspaces: ["apps/*"],
          }),
        },
        {
          path: "apps/portal/package.json",
          text: JSON.stringify({
            name: "@acme/portal",
            scripts: { serve: "ng serve --port 4200" },
          }),
        },
        {
          path: "apps/portal/src/app/app.component.ts",
          text: "export class AppComponent {}",
        },
        { path: "package-lock.json", text: "{}" },
      ],
      repoUrl: "https://github.com/example/angular-monorepo",
    });

    expect(profile.browserRuntimeCandidates).toEqual([
      expect.objectContaining({
        dir: "apps/portal",
        frameworks: ["angular"],
        ports: [4200],
      }),
    ]);
  });

  it("uses pnpm-workspace membership instead of treating every nested package as a workspace", () => {
    const profile = profileRepo({
      files: [
        { path: "package.json", text: JSON.stringify({ private: true }) },
        {
          path: "pnpm-workspace.yaml",
          text: "packages:\n  - 'apps/*'\n  - '!apps/legacy'\n",
        },
        { path: "pnpm-lock.yaml", text: "" },
        {
          path: "apps/web/package.json",
          text: JSON.stringify({ name: "@acme/web", scripts: { dev: "vite" } }),
        },
        {
          path: "apps/legacy/package.json",
          text: JSON.stringify({ name: "legacy", scripts: { dev: "vite" } }),
        },
      ],
      repoUrl: "https://github.com/example/pnpm-workspace",
    });

    expect(profile.workspaces).toEqual({
      isMonorepo: true,
      packageDirectories: ["apps/*", "!apps/legacy"],
    });
    expect(
      profile.workspacePackages?.find(({ dir }) => dir === "apps/web"),
    ).toMatchObject({
      installDir: ".",
      isWorkspace: true,
      packageManager: "pnpm",
    });
    expect(
      profile.workspacePackages?.find(({ dir }) => dir === "apps/legacy"),
    ).toMatchObject({
      installDir: "apps/legacy",
      isWorkspace: false,
      packageManager: "npm",
    });
  });

  it("profiles declared and source-observed internal workspace dependencies", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
        },
        {
          path: "apps/web/package.json",
          text: JSON.stringify({
            dependencies: { "@acme/ui": "workspace:*" },
            name: "@acme/web",
            scripts: { dev: "vite" },
          }),
        },
        {
          path: "apps/web/src/app.tsx",
          text: [
            'import { track } from "@acme/events/client";',
            'const documentationExample = "@acme/unused";',
          ].join("\n"),
        },
        {
          path: "packages/events/package.json",
          text: JSON.stringify({ name: "@acme/events" }),
        },
        {
          path: "packages/ui/package.json",
          text: JSON.stringify({ name: "@acme/ui" }),
        },
        {
          path: "packages/unused/package.json",
          text: JSON.stringify({ name: "@acme/unused" }),
        },
        { path: "bun.lock", text: "" },
      ],
      repoUrl: "https://github.com/example/workspace",
    });

    expect(
      profile.workspacePackages?.find(({ name }) => name === "@acme/web"),
    ).toMatchObject({
      workspaceDependencies: ["@acme/events", "@acme/ui"],
    });
  });
});
