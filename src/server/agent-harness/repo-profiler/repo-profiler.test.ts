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

  it("reads the yarn variant from the repo's own identity, not command flags", () => {
    // excalidraw (2026-08-08 matrix): pinned yarn@1.22.22, but the agent's
    // berry-style `--immutable` flag made the lifecycle issue `yarn
    // rebuild`, which classic yarn does not have.
    const classic = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            packageManager: "yarn@1.22.22",
            scripts: { dev: "vite" },
          }),
        },
        { path: "yarn.lock", text: "" },
      ],
      repoUrl: "https://github.com/example/classic-pin",
    });
    expect(classic.yarnVariant).toBe("classic");

    const berry = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({
            packageManager: "yarn@4.12.0",
            scripts: { dev: "vite" },
          }),
        },
        { path: "yarn.lock", text: "" },
      ],
      repoUrl: "https://github.com/example/berry-pin",
    });
    expect(berry.yarnVariant).toBe("berry");
  });

  it("infers the berry variant from .yarnrc.yml when the pin is absent", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ scripts: { dev: "vite" } }),
        },
        { path: ".yarnrc.yml", text: "nodeLinker: node-modules\n" },
        { path: "yarn.lock", text: "" },
      ],
      repoUrl: "https://github.com/example/vendored-berry",
    });

    expect(profile.yarnVariant).toBe("berry");
  });

  it("leaves the yarn variant unset without yarn evidence", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ scripts: { dev: "vite" } }),
        },
        { path: "package-lock.json", text: "{}" },
      ],
      repoUrl: "https://github.com/example/npm-repo",
    });

    expect(profile.yarnVariant).toBeUndefined();
  });

  it("records that the repo's own config disables lifecycle scripts", () => {
    // N160(2), outline: enableScripts: false means a real install in this
    // repo runs no lifecycle scripts, so the harness's offline lifecycle
    // pass has no work and must be skipped.
    const berry = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ scripts: { dev: "vite" } }),
        },
        {
          path: ".yarnrc.yml",
          text: "nodeLinker: node-modules\n\nenableScripts: false\n\nnpmMinimalAgeGate: 4320\n",
        },
        { path: "yarn.lock", text: "" },
      ],
      repoUrl: "https://github.com/example/outline",
    });
    const npm = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ scripts: { dev: "vite" } }),
        },
        { path: ".npmrc", text: "ignore-scripts=true\n" },
        { path: "package-lock.json", text: "{}" },
      ],
      repoUrl: "https://github.com/example/npm-repo",
    });

    expect(berry.lifecycleScriptsDisabled).toBe(true);
    expect(npm.lifecycleScriptsDisabled).toBe(true);
  });

  it("leaves lifecycleScriptsDisabled unset when scripts stay enabled", () => {
    const commentedOut = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ scripts: { dev: "vite" } }),
        },
        {
          path: ".yarnrc.yml",
          text: "# enableScripts: false\nnodeLinker: node-modules\nenableScripts: true\n",
        },
        { path: "yarn.lock", text: "" },
      ],
      repoUrl: "https://github.com/example/scripts-enabled",
    });
    const nestedOnly = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ scripts: { dev: "vite" } }),
        },
        // A member's config never speaks for the repo root the install
        // runs from.
        { path: "packages/tool/.npmrc", text: "ignore-scripts=true\n" },
        { path: "package-lock.json", text: "{}" },
      ],
      repoUrl: "https://github.com/example/nested-config",
    });

    expect(commentedOut.lifecycleScriptsDisabled).toBeUndefined();
    expect(nestedOnly.lifecycleScriptsDisabled).toBeUndefined();
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

  it("excludes native mobile workspaces so a lone web candidate remains", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ workspaces: ["apps/*"] }),
        },
        { path: "yarn.lock", text: "" },
        {
          path: "apps/mobile/package.json",
          text: JSON.stringify({
            dependencies: { expo: "51.0.0", "react-native": "0.74.0" },
            name: "@acme/mobile",
            scripts: { dev: "expo start" },
          }),
        },
        { path: "apps/mobile/src/screens/home.tsx", text: "export {};" },
        {
          path: "apps/web/package.json",
          text: JSON.stringify({
            dependencies: { next: "15.0.0" },
            name: "@acme/web",
            scripts: { dev: "next dev" },
          }),
        },
        { path: "apps/web/src/app/page.tsx", text: "export {};" },
      ],
      repoUrl: "https://github.com/example/native-and-web",
    });

    expect(profile.browserRuntimeCandidates?.map(({ dir }) => dir)).toEqual([
      "apps/web",
    ]);
  });

  it("keeps a react-native-web workspace as a browser candidate", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ workspaces: ["apps/*"] }),
        },
        { path: "yarn.lock", text: "" },
        {
          path: "apps/universal/package.json",
          text: JSON.stringify({
            dependencies: {
              react: "18.0.0",
              "react-native": "0.74.0",
              "react-native-web": "0.19.0",
            },
            name: "@acme/universal",
            scripts: { dev: "vite" },
          }),
        },
        { path: "apps/universal/src/app.tsx", text: "export {};" },
      ],
      repoUrl: "https://github.com/example/universal",
    });

    expect(profile.browserRuntimeCandidates?.map(({ dir }) => dir)).toEqual([
      "apps/universal",
    ]);
  });

  it("harvests nx project.json run targets as runtime scripts", () => {
    // An nx-managed product app can carry only a build script in its
    // package.json while its serve targets live in project.json; without
    // harvesting them the product never becomes a browser runtime candidate.
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ workspaces: ["packages/*"] }),
        },
        { path: "yarn.lock", text: "" },
        {
          path: "packages/twenty-front/package.json",
          text: JSON.stringify({
            dependencies: { react: "19.0.0" },
            name: "twenty-front",
            scripts: { build: "npx vite build" },
          }),
        },
        {
          path: "packages/twenty-front/project.json",
          text: JSON.stringify({
            name: "twenty-front",
            targets: {
              build: { options: { outputPath: "{projectRoot}/build" } },
              lint: { executor: "nx:run-commands" },
              preview: {
                executor: "@nx/vite:preview-server",
                options: { buildTarget: "twenty-front:build", port: 3001 },
              },
              start: {
                executor: "@nx/vite:dev-server",
                options: { buildTarget: "twenty-front:build", hmr: true },
              },
            },
          }),
        },
        { path: "packages/twenty-front/src/App.tsx", text: "export {};" },
      ],
      repoUrl: "https://github.com/example/twenty",
    });

    expect(profile.browserRuntimeCandidates).toMatchObject([
      {
        dir: "packages/twenty-front",
        scripts: {
          build: "npx vite build",
          preview: "nx run twenty-front:preview --port=3001",
          start: "nx run twenty-front:start",
        },
      },
    ]);
    expect(profile.browserRuntimeCandidates?.[0]?.ports).toContain(3001);
    expect(profile.browserRuntimeCandidates?.[0]?.scripts).not.toHaveProperty(
      "lint",
    );
  });

  it("flags storybook and e2e evidence as role hints on browser candidates", () => {
    const profile = profileRepo({
      files: [
        {
          path: "package.json",
          text: JSON.stringify({ workspaces: ["apps/*"] }),
        },
        { path: "bun.lock", text: "" },
        {
          path: "apps/design/package.json",
          text: JSON.stringify({
            dependencies: { cypress: "13.0.0", react: "18.0.0" },
            name: "@acme/design",
            scripts: { dev: "storybook dev -p 6006" },
          }),
        },
        { path: "apps/design/.storybook/main.ts", text: "export {};" },
        {
          path: "apps/design/src/button.stories.tsx",
          text: "export {};",
        },
      ],
      repoUrl: "https://github.com/example/design-system",
    });

    expect(profile.browserRuntimeCandidates?.[0]?.roleHints).toEqual([
      "e2e",
      "storybook",
    ]);
  });

  it("profiles a 70k-file monorepo in linear time", () => {
    const files = [
      {
        path: "package.json",
        text: JSON.stringify({ workspaces: ["apps/*"] }),
      },
      { path: "bun.lock", text: "" },
    ];
    for (let app = 0; app < 200; app += 1) {
      files.push({
        path: `apps/app-${app}/package.json`,
        text: JSON.stringify({
          dependencies: { vite: "5.0.0" },
          name: `@acme/app-${app}`,
          scripts: { dev: "vite" },
        }),
      });
      for (let file = 0; file < 349; file += 1) {
        files.push({
          path: `apps/app-${app}/src/components/component-${file}.tsx`,
          text: "export {};",
        });
      }
    }

    const startedAt = performance.now();
    const profile = profileRepo({
      files,
      repoUrl: "https://github.com/example/huge-monorepo",
    });
    const elapsedMs = performance.now() - startedAt;

    expect(profile.browserRuntimeCandidates).toHaveLength(200);
    // Solo this profiles in well under 1s; the bound carries headroom for
    // parallel-suite load while still failing the old quadratic (2.2s solo).
    expect(elapsedMs).toBeLessThan(2000);
  }, 120_000);

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

  // N122(1): the servicesRequired inventory is the detection half of the
  // data-backend ladder's closed loop — every signal class a repo can use to
  // declare a data service must land here with its evidence, so enforcement
  // can demand a dataStrategy answer for each entry.
  describe("servicesRequired detection", () => {
    it("reports no required services for a repo without data-backend signals", () => {
      const profile = profileRepo({
        files: [
          {
            path: "package.json",
            text: JSON.stringify({
              dependencies: { react: "18" },
              scripts: { dev: "vite" },
            }),
          },
          { path: ".env.example", text: "PUBLIC_API_ORIGIN=\n" },
          { path: "src/app/page.tsx", text: "export default () => null;" },
        ],
        repoUrl: "https://github.com/example/static-app",
      });

      expect(profile.servicesRequired).toEqual([]);
    });

    it("detects compose-declared services with the compose file as evidence", () => {
      const profile = profileRepo({
        files: [
          { path: "package.json", text: JSON.stringify({}) },
          {
            path: "docker-compose.yml",
            text: [
              "services:",
              "  db:",
              "    image: postgres:16-alpine",
              "  cache:",
              "    image: redis:7",
            ].join("\n"),
          },
        ],
        repoUrl: "https://github.com/example/composed",
      });

      expect(profile.servicesRequired).toEqual([
        { evidencePaths: ["docker-compose.yml"], service: "postgres" },
        { evidencePaths: ["docker-compose.yml"], service: "redis" },
      ]);
    });

    it("detects services from environment URL schemes", () => {
      const profile = profileRepo({
        files: [
          { path: "package.json", text: JSON.stringify({}) },
          {
            path: ".env.example",
            text: [
              'DATABASE_URL="postgresql://user:pass@localhost:5432/app"',
              "REDIS_URL=redis://localhost:6379",
            ].join("\n"),
          },
        ],
        repoUrl: "https://github.com/example/env-schemes",
      });

      expect(profile.servicesRequired).toEqual([
        { evidencePaths: [".env.example"], service: "postgres" },
        { evidencePaths: [".env.example"], service: "redis" },
      ]);
    });

    it("detects the prisma datasource provider", () => {
      const profile = profileRepo({
        files: [
          { path: "package.json", text: JSON.stringify({}) },
          {
            path: "packages/prisma/schema.prisma",
            text: [
              "datasource db {",
              '  provider = "postgresql"',
              '  url      = env("DATABASE_URL")',
              "}",
            ].join("\n"),
          },
        ],
        repoUrl: "https://github.com/example/prisma-app",
      });

      expect(profile.servicesRequired).toEqual([
        {
          evidencePaths: ["packages/prisma/schema.prisma"],
          service: "postgres",
        },
      ]);
    });

    it("detects database clients from ORM configuration files", () => {
      const profile = profileRepo({
        files: [
          { path: "package.json", text: JSON.stringify({}) },
          {
            path: "knexfile.js",
            text: "module.exports = { client: 'pg', connection: {} };",
          },
          {
            path: "drizzle.config.ts",
            text: 'export default { dialect: "mysql", schema: "./schema.ts" };',
          },
        ],
        repoUrl: "https://github.com/example/orm-configs",
      });

      expect(profile.servicesRequired).toEqual([
        { evidencePaths: ["drizzle.config.ts"], service: "mysql" },
        { evidencePaths: ["knexfile.js"], service: "postgres" },
      ]);
    });

    it("detects driver dependencies with their manifest as evidence", () => {
      const profile = profileRepo({
        files: [
          {
            path: "package.json",
            text: JSON.stringify({
              dependencies: { ioredis: "5", mongoose: "8" },
            }),
          },
        ],
        repoUrl: "https://github.com/example/driver-deps",
      });

      expect(profile.servicesRequired).toEqual([
        { evidencePaths: ["package.json"], service: "mongodb" },
        { evidencePaths: ["package.json"], service: "redis" },
      ]);
    });

    it("merges one service's evidence across signal classes", () => {
      const profile = profileRepo({
        files: [
          {
            path: "package.json",
            text: JSON.stringify({ dependencies: { pg: "8" } }),
          },
          {
            path: "docker-compose.yml",
            text: "services:\n  db:\n    image: postgres:16",
          },
          {
            path: ".env.example",
            text: "DATABASE_URL=postgres://localhost:5432/app\n",
          },
        ],
        repoUrl: "https://github.com/example/merged-evidence",
      });

      expect(profile.servicesRequired).toEqual([
        {
          evidencePaths: [".env.example", "docker-compose.yml", "package.json"],
          service: "postgres",
        },
      ]);
    });

    it("marks the embedded sqlite alternative on relational services", () => {
      const profile = profileRepo({
        files: [
          {
            path: "package.json",
            text: JSON.stringify({
              dependencies: { "better-sqlite3": "11", pg: "8" },
            }),
          },
        ],
        repoUrl: "https://github.com/example/multi-driver",
      });

      expect(profile.servicesRequired).toEqual([
        {
          embeddedAlternativeEvidencePaths: ["package.json"],
          evidencePaths: ["package.json"],
          service: "postgres",
        },
      ]);
    });

    it("treats a sqlite-only data layer as requiring no services", () => {
      const profile = profileRepo({
        files: [
          {
            path: "package.json",
            text: JSON.stringify({ dependencies: { "better-sqlite3": "11" } }),
          },
          {
            path: "prisma/schema.prisma",
            text: 'datasource db {\n  provider = "sqlite"\n}',
          },
        ],
        repoUrl: "https://github.com/example/sqlite-only",
      });

      expect(profile.servicesRequired).toEqual([]);
    });
  });
});
