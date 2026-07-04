import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Daytona image verifier", () => {
  it("uses the submitted-code snapshot env var expected by the Daytona provider", async () => {
    const script = await readVerifierScript();

    expect(script).toContain("MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT");
    expect(script).toContain("submittedCodeSnapshot");
    expect(script).not.toContain("MAKEADEMO_SUBMITTED_CODE_IMAGE");
    expect(script).not.toContain("submittedCodeImage");
  });

  it("checks native Git HTTPS trust in both Daytona images", async () => {
    const script = await readVerifierScript();

    expect(script).toContain("git --version");
    expect(script).toContain(
      "git ls-remote https://github.com/octocat/Hello-World.git HEAD",
    );
    expect(script).toContain('NODE_PATH="$(npm root -g)"');
    expect(script).toContain('assertCommandSucceeded("parent Git/CA trust"');
    expect(script).toContain('assertCommandSucceeded("submitted-code runtime"');
  });
});

async function readVerifierScript(): Promise<string> {
  return await readFile(
    join(import.meta.dirname, "..", "scripts", "verify-daytona-image.mts"),
    "utf8",
  );
}
