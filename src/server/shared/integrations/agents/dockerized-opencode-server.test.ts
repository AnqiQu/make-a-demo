import { describe, expect, it } from "vitest";

import { createDockerizedOpencodeServerCommand } from "./dockerized-opencode-server";

describe("createDockerizedOpencodeServerCommand", () => {
  it("mounts only the OpenCode binary and the prepared workspace", () => {
    const command = createDockerizedOpencodeServerCommand({
      containerPort: 4096,
      hostPort: 49152,
      opencodeBinaryPath: "/home/milo/.opencode/bin/opencode",
      opencodeHomeDirectory: "/tmp/makeademo-opencode-home-abc123",
      workspaceDirectory: "/tmp/makeademo-workspaces/workspace-123",
    });

    expect(command.executable).toBe("docker");
    expect(command.args).toContain(
      "/home/milo/.opencode/bin/opencode:/usr/local/bin/opencode:ro",
    );
    expect(command.args).toContain(
      "/tmp/makeademo-workspaces/workspace-123:/workspace",
    );
    expect(command.args).toContain(
      "/tmp/makeademo-opencode-home-abc123:/tmp/opencode-home",
    );
    expect(command.args).toContain("/workspace");
    expect(command.args.join(" ")).not.toContain("/tmp/makeademo-workspaces:/");
    expect(command.args.join(" ")).not.toContain("/home/milo:/");
  });

  it("configures OpenCode to allow all permissions without questions", () => {
    const command = createDockerizedOpencodeServerCommand({
      containerPort: 4096,
      hostPort: 49152,
      opencodeBinaryPath: "/home/milo/.opencode/bin/opencode",
      opencodeHomeDirectory: "/tmp/makeademo-opencode-home-abc123",
      workspaceDirectory: "/tmp/makeademo-workspaces/workspace-123",
    });
    const configEnv = command.args.find((arg) =>
      arg.startsWith("OPENCODE_CONFIG_CONTENT="),
    );
    const config = JSON.parse(
      configEnv?.replace("OPENCODE_CONFIG_CONTENT=", "") ?? "{}",
    );

    expect(config.permission).toBe("allow");
    expect(config.tools.question).toBe(false);
  });

  it("enables OpenCode web search through the Exa feature flag", () => {
    const command = createDockerizedOpencodeServerCommand({
      containerPort: 4096,
      hostPort: 49152,
      opencodeBinaryPath: "/home/milo/.opencode/bin/opencode",
      opencodeHomeDirectory: "/tmp/makeademo-opencode-home-abc123",
      workspaceDirectory: "/tmp/makeademo-workspaces/workspace-123",
    });

    expect(command.args).toContain("OPENCODE_ENABLE_EXA=1");
  });
});
