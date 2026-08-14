import { describe, expect, it } from "vitest";
import type { RepoProfile } from "../schemas/artifacts";
import { selectSubmittedCodeSandboxClass } from "./submitted-code-sandbox-class";

describe("selectSubmittedCodeSandboxClass", () => {
  it.each([
    {
      expected: "standard",
      name: "a profile without size evidence",
      profile: {},
    },
    {
      expected: "standard",
      name: "the largest profile below both boundaries",
      profile: {
        archiveSizeBytes: 127_999_999,
        workspacePackages: workspacePackages(63),
      },
    },
    {
      expected: "heavyweight",
      name: "Twenty's measured screened archive",
      profile: {
        archiveSizeBytes: 134_113_964,
        workspacePackages: workspacePackages(40),
      },
    },
    {
      expected: "heavyweight",
      name: "a small archive with 64 workspace packages",
      profile: {
        archiveSizeBytes: 8_000_000,
        workspacePackages: workspacePackages(64),
      },
    },
  ] as const)("selects $expected for $name", ({ expected, profile }) => {
    expect(
      selectSubmittedCodeSandboxClass(
        profile as Pick<RepoProfile, "archiveSizeBytes" | "workspacePackages">,
      ),
    ).toBe(expected);
  });
});

function workspacePackages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    dir: `packages/package-${index}`,
    ports: [],
    scripts: {},
  }));
}
