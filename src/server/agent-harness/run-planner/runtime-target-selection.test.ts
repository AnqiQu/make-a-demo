import { describe, expect, it } from "vitest";
import type { RepoProfile } from "../schemas/artifacts";
import {
  RuntimeTargetSelectionRequiredError,
  createExplicitRuntimeTargetSelection,
  readModelRuntimeTargetSelection,
} from "./runtime-target-selection";

describe("runtime target selection", () => {
  it("accepts one evidence-backed assessment for every browser application", () => {
    expect(
      readModelRuntimeTargetSelection(
        {
          candidates: [
            {
              evidencePaths: ["apps/website/src/app/page.tsx"],
              reason: "Public acquisition pages and pricing.",
              role: "marketing",
              targetId: "apps/website",
            },
            {
              evidencePaths: ["apps/dashboard/src/app/page.tsx"],
              reason: "Authenticated product workflows match the demo brief.",
              role: "product",
              targetId: "apps/dashboard",
            },
          ],
          reason: "The dashboard contains the user-facing product workflows.",
          selectedTargetId: "apps/dashboard",
        },
        profile(),
      ),
    ).toEqual({
      evidencePaths: ["apps/dashboard/src/app/page.tsx"],
      reason: "The dashboard contains the user-facing product workflows.",
      role: "product",
      source: "model",
      targetId: "apps/dashboard",
    });
  });

  it("rejects decisions that skip a candidate or cite unsupported evidence", () => {
    expect(() =>
      readModelRuntimeTargetSelection(
        {
          candidates: [
            {
              evidencePaths: ["README.md"],
              reason: "Looks like the product.",
              role: "product",
              targetId: "apps/dashboard",
            },
          ],
          reason: "Selected dashboard.",
          selectedTargetId: "apps/dashboard",
        },
        profile(),
      ),
    ).toThrow(/exactly once/);
  });

  it("requires an explicit target when repository evidence is ambiguous", () => {
    expect(() =>
      readModelRuntimeTargetSelection(
        {
          candidates: [
            {
              evidencePaths: ["apps/website/src/app/page.tsx"],
              reason: "Could be the intended public experience.",
              role: "unknown",
              targetId: "apps/website",
            },
            {
              evidencePaths: ["apps/dashboard/src/app/page.tsx"],
              reason: "Could be the intended signed-in experience.",
              role: "unknown",
              targetId: "apps/dashboard",
            },
          ],
          reason: "The demo brief does not distinguish these applications.",
          selectedTargetId: null,
        },
        profile(),
      ),
    ).toThrow(RuntimeTargetSelectionRequiredError);
  });

  it("honors a valid maker override without model inference", () => {
    expect(
      createExplicitRuntimeTargetSelection(profile(), "apps/dashboard"),
    ).toMatchObject({
      source: "explicit",
      targetId: "apps/dashboard",
    });
    expect(() =>
      createExplicitRuntimeTargetSelection(profile(), "apps/missing"),
    ).toThrow(/not a profiled browser application/);
  });
});

function profile(): RepoProfile {
  return {
    authHints: [],
    browserRuntimeCandidates: [
      {
        dir: "apps/website",
        evidencePaths: [
          "apps/website/package.json",
          "apps/website/src/app/page.tsx",
        ],
        frameworks: ["next", "react"],
        installDir: ".",
        isWorkspace: true,
        ports: [3000],
        scripts: { dev: "next dev" },
      },
      {
        dir: "apps/dashboard",
        evidencePaths: [
          "apps/dashboard/package.json",
          "apps/dashboard/src/app/page.tsx",
        ],
        frameworks: ["next", "react"],
        installDir: ".",
        isWorkspace: true,
        ports: [3001],
        scripts: { dev: "next dev -p 3001" },
      },
    ],
    candidateAppDirs: ["apps/website", "apps/dashboard"],
    candidateBuildCommands: [],
    candidateInstallCommands: ["bun install --frozen-lockfile"],
    candidatePorts: [3000, 3001],
    candidateStartCommands: ["bun run dev"],
    confidence: { assumptions: [], overall: 0.9 },
    detectedFrameworks: ["next", "react"],
    dockerHints: [],
    envExamples: [],
    externalServiceHints: [],
    lockfiles: ["bun.lock"],
    packageManager: "bun",
    packageScripts: { dev: "turbo dev" },
    repoUrl: "https://github.com/example/app",
    requiredEnvHints: [],
    rootDir: "/workspace",
    securityWarnings: [],
    unsupportedReasons: [],
    workspaces: { isMonorepo: true, packageDirectories: ["apps/*"] },
  };
}
