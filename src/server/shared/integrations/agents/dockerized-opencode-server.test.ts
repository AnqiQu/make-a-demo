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

  it("configures OpenCode to allow tool permissions without questions", () => {
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

    expect(config.permission).toMatchObject({
      bash: "allow",
      doom_loop: "allow",
      edit: "allow",
      external_directory: "allow",
      question: "deny",
      webfetch: "allow",
    });
    expect(config.tools.question).toBe(false);
  });
});
