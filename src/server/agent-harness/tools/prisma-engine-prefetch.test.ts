import { describe, expect, it } from "vitest";

import { createPrismaEnginePrefetchCommand } from "./prisma-engine-prefetch";

describe("createPrismaEnginePrefetchCommand", () => {
  it("warms every installed @prisma/engines package with the sandbox platform's engines", () => {
    const command = createPrismaEnginePrefetchCommand();

    expect(command).toContain("node_modules/@prisma/engines");
    expect(command).toContain("@prisma/engines-version/package.json");
    expect(command).toContain("binaries.prisma.sh/all_commits");
    expect(command).toContain("libquery_engine-debian-openssl-3.0.x.so.node");
    expect(command).toContain("schema-engine-debian-openssl-3.0.x");
  });

  it("writes engines atomically and never fails the install window", () => {
    const command = createPrismaEnginePrefetchCommand();

    // A half-written engine binary would poison every later offline
    // lifecycle round, and a prefetch stumble must not fail an install
    // that already succeeded.
    expect(command).toContain('.tmp" && mv ');
    expect(command).toContain('rm -f "$target.tmp"');
    expect(command.trimEnd().endsWith("true")).toBe(true);
  });
});
