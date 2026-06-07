import { describe, expect, it } from "vitest";

import { DockerSandboxRunner } from "./docker-sandbox-runner";

describe("DockerSandboxRunner", () => {
  it("is an explicit stub until sandbox execution is implemented", async () => {
    const runner = new DockerSandboxRunner();

    await expect(
      runner.runValidation({
        config: {
          demoCommand: "npm run demo",
          url: "http://localhost:3000",
        },
        demoCommand: "npm run demo",
        repoUrl: "https://github.com/example/app",
        url: "http://localhost:3000",
      }),
    ).rejects.toThrowError("DockerSandboxRunner is a stub");
  });
});
