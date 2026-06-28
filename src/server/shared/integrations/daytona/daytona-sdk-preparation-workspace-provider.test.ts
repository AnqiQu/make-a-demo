import { describe, expect, it } from "vitest";

import {
  DaytonaSdkPreparationWorkspaceProvider,
  createDaytonaSdkPreparationWorkspaceHandle,
} from "./daytona-sdk-preparation-workspace-provider";

describe("DaytonaSdkPreparationWorkspaceProvider", () => {
  it("creates a sandbox from the configured snapshot", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
      snapshot: "makeademo-opencode",
    });

    const handle = await provider.create();

    expect(handle.id).toBe("sandbox_123");
    expect(calls[0]).toEqual({
      create: {
        disk: 3,
        snapshot: "makeademo-opencode",
      },
    });
  });

  it("uploads screened workspace files with Daytona fs.uploadFiles", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.uploadFiles([
      {
        destinationPath: "/workspace/package.json",
        sourcePath: "/tmp/repo/package.json",
      },
    ]);

    expect(calls[1]).toEqual({
      uploadFiles: [
        {
          destination: "/workspace/package.json",
          source: "/tmp/repo/package.json",
        },
      ],
    });
  });

  it("downloads captured workspace artifacts with Daytona fs.downloadFiles", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.downloadFiles?.([
      {
        destinationPath: "/tmp/capture/scene.webm",
        sourcePath: "/workspace/.makeademo/capture/scene.webm",
      },
    ]);

    expect(calls[1]).toEqual({
      downloadFiles: {
        files: [
          {
            destination: "/tmp/capture/scene.webm",
            source: "/tmp/makeademo/submitted-code/capture/scene.webm",
          },
        ],
        timeoutSec: 0,
      },
    });
  });

  it("fails when Daytona cannot download a captured workspace artifact", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { downloadError: "missing file" }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.downloadFiles?.([
        {
          destinationPath: "/tmp/capture/scene.webm",
          sourcePath: "/workspace/.makeademo/capture/scene.webm",
        },
      ]),
    ).rejects.toThrow(
      "Failed to download Daytona sandbox file /tmp/makeademo/submitted-code/capture/scene.webm: missing file",
    );
  });

  it("uploads submitted-code control artifacts to the separate control mount", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.uploadFiles([
      {
        destinationPath: "/workspace/.makeademo/capture/script.ts",
        sourcePath: "/tmp/script.ts",
      },
    ]);

    expect(calls[1]).toEqual({
      uploadFiles: [
        {
          destination: "/tmp/makeademo/submitted-code/capture/script.ts",
          source: "/tmp/script.ts",
        },
      ],
    });
  });

  it("reconnects to an existing sandbox as a preparation workspace", async () => {
    const calls: unknown[] = [];

    const handle = await createDaytonaSdkPreparationWorkspaceHandle({
      client: fakeClient(calls),
      sandboxId: "sandbox_existing",
    });
    const result = await handle.workspace.execute("pwd");

    expect(handle.id).toBe("sandbox_existing");
    expect(result.stdout).toBe("ok");
    expect(calls).toEqual([
      { get: "sandbox_existing" },
      { executeCommand: "pwd" },
    ]);
  });

  it("executes commands, updates network settings, and deletes the sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("opencode run hello");
    await handle.workspace.setOutboundNetworkAccess(false);
    await handle.destroy();

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ok" });
    expect(calls.slice(1)).toEqual([
      { executeCommand: "opencode run hello" },
      { updateNetworkSettings: { networkBlockAll: true } },
      { delete: "sandbox_123" },
    ]);
  });

  it("resolves signed preview URLs for browser validation", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await expect(handle.workspace.getPreviewUrl(4173)).resolves.toBe(
      "https://preview.example.test:4173",
    );
    expect(calls[1]).toEqual({
      getSignedPreviewUrl: { port: 4173, ttl: 3600 },
    });
  });

  it("streams command output through a Daytona PTY when callbacks are provided", async () => {
    const calls: unknown[] = [];
    const streamed: string[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("opencode run hello", {
      onStderr: (chunk) => streamed.push(`stderr:${chunk}`),
      onStdout: (chunk) => streamed.push(`stdout:${chunk}`),
    });

    expect(result).toEqual({
      exitCode: 7,
      stderr: "",
      stdout: "hello\n",
    });
    expect(streamed).toEqual(["stdout:hello\n"]);
    expect(calls.slice(1)).toEqual([
      {
        createPty: {
          cols: 120,
          cwd: "/workspace",
          envs: {},
          id: expect.stringMatching(/^makeademo-/),
          rows: 30,
        },
      },
      { waitForConnection: true },
      {
        sendInput:
          "stty -echo\nopencode run hello\nprintf '\\n__MAKEADEMO_EXIT__:%s\\n' $?\nexit\n",
      },
      { wait: true },
      { disconnect: true },
    ]);
  });

  it("writes Pino-formatted sandbox logs through durable files", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.writeSandboxLog?.({
      event: "repo-preparation.started",
      stage: "repo-preparation",
      timestamp: "2026-06-17T00:00:00.000Z",
    });
    await handle.workspace.writeSandboxLog?.({
      event: "repo-preparation.succeeded",
      stage: "repo-preparation",
    });

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          executeCommand: expect.stringContaining(
            "/tmp/makeademo/sandbox-log.jsonl",
          ),
        },
        {
          executeCommand: expect.stringContaining(
            '"event":"repo-preparation.succeeded"',
          ),
        },
        {
          executeCommand: expect.stringContaining('"level":"info"'),
        },
        {
          executeCommand: expect.stringContaining(
            '"message":"repo-preparation.succeeded"',
          ),
        },
        {
          executeCommand: expect.stringContaining('"service":"makeademo"'),
        },
        {
          executeCommand: expect.stringContaining(
            '"eventTime":"2026-06-17T00:00:00.000Z"',
          ),
        },
      ]),
    );
    const sandboxLogWrites = calls
      .filter(
        (call): call is { executeCommand: string } =>
          typeof call === "object" &&
          call !== null &&
          "executeCommand" in call &&
          typeof call.executeCommand === "string" &&
          call.executeCommand.includes("/tmp/makeademo/sandbox-log.jsonl"),
      )
      .map((call) => call.executeCommand);
    expect(sandboxLogWrites).not.toHaveLength(0);
    for (const command of sandboxLogWrites) {
      expect(countOccurrences(command, '"workspaceId"')).toBe(1);
      expect(countOccurrences(command, '"message"')).toBe(1);
      expect(command).not.toContain('"timestamp"');
      expect(command).not.toContain("/workspace/.makeademo");
      expect(command).not.toContain("/tmp/makeademo/submitted-code");
    }
    expect(
      calls.filter(
        (call) =>
          typeof call === "object" && call !== null && "createSession" in call,
      ),
    ).toHaveLength(0);
  });

  it("disconnects active streaming commands before deleting the sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyWaitsForDisconnect: true }),
    });
    const handle = await provider.create();

    const execution = handle.workspace.execute("opencode run slow", {
      onStdout: () => {},
    });
    await Promise.resolve();
    await handle.destroy();

    await expect(execution).resolves.toMatchObject({ exitCode: 7 });
    expect(calls).toEqual(
      expect.arrayContaining([{ disconnect: true }, { delete: "sandbox_123" }]),
    );
    expect(
      calls.findIndex((call) => "disconnect" in Object(call)),
    ).toBeLessThan(calls.findIndex((call) => "delete" in Object(call)));
  });

  it("passes streaming command environment variables through PTY options", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.execute("opencode run hello", {
      env: { OPENAI_API_KEY: "secret" },
      onStdout: () => {},
    });

    expect(calls[1]).toEqual({
      createPty: expect.objectContaining({
        envs: { OPENAI_API_KEY: "secret" },
      }),
    });
  });

  it("fails fast when a streaming PTY never connects", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyNeverConnects: true }),
      ptyConnectionTimeoutMs: 1,
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("opencode run hello", {
        onStdout: () => {},
      }),
    ).rejects.toThrow("Daytona PTY did not connect within 1ms");

    expect(calls).toEqual(
      expect.arrayContaining([
        { waitForConnection: true },
        { disconnect: true },
      ]),
    );
  });

  it("continues when Daytona org policy rejects sandbox-level network overrides", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        networkError: new Error(
          "Network access is restricted and cannot be overridden at the sandbox level.",
        ),
      }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.setOutboundNetworkAccess(true),
    ).resolves.toBeUndefined();
    await expect(
      handle.workspace.setOutboundNetworkAccess(false),
    ).resolves.toBeUndefined();

    expect(calls.slice(1)).toEqual([
      { updateNetworkSettings: { networkBlockAll: false } },
      { updateNetworkSettings: { networkBlockAll: true } },
    ]);
  });

  it("executes submitted repo commands through a long-lived inner Docker container", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.executeSubmittedCode?.("npm run build", {
      env: {
        NODE_ENV: "production",
        OPENAI_API_KEY: "secret",
        VITE_PUBLIC_DEMO_MODE: "1",
      },
    });

    const commands = calls
      .filter(
        (call): call is { executeCommand: string } =>
          typeof call === "object" &&
          call !== null &&
          "executeCommand" in call &&
          typeof call.executeCommand === "string",
      )
      .map((call) => call.executeCommand);
    const sentInput = calls
      .filter(
        (call): call is { sendInput: string } =>
          typeof call === "object" &&
          call !== null &&
          "sendInput" in call &&
          typeof call.sendInput === "string",
      )
      .map((call) => call.sendInput)
      .join("\n");
    const dockerBoundaryCommands = `${commands.join("\n")}\n${sentInput}`;

    expect(dockerBoundaryCommands).toContain("docker run -d");
    expect(dockerBoundaryCommands).toContain("docker exec");
    expect(dockerBoundaryCommands).toContain("dockerd");
    expect(dockerBoundaryCommands).toContain("--network none");
    expect(dockerBoundaryCommands).toContain("--read-only");
    expect(dockerBoundaryCommands).toContain("--tmpfs /tmp");
    expect(dockerBoundaryCommands).toContain("/workspace:/workspace");
    expect(dockerBoundaryCommands).toContain(
      "/tmp/makeademo/submitted-code:/workspace/.makeademo",
    );
    expect(dockerBoundaryCommands).toContain("-e 'NODE_ENV=production'");
    expect(dockerBoundaryCommands).toContain("-e 'VITE_PUBLIC_DEMO_MODE=1'");
    expect(dockerBoundaryCommands).not.toContain("OPENAI_API_KEY");
    expect(dockerBoundaryCommands).not.toContain("DATABASE_URL");
    expect(dockerBoundaryCommands).not.toContain("GITHUB_PRIVATE_KEY");
    expect(dockerBoundaryCommands).not.toContain("/root/.opencode");
    expect(dockerBoundaryCommands).not.toContain(
      "/workspace/.makeademo/opencode",
    );
    expect(dockerBoundaryCommands).toContain("trap");
    expect(dockerBoundaryCommands).toContain("docker rm -f");
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          createPty: expect.objectContaining({
            envs: {},
          }),
        },
      ]),
    );
  });

  it("streams submitted-code output through managed command callbacks", async () => {
    const calls: unknown[] = [];
    const streamed: string[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    const result = await handle.workspace.executeSubmittedCode?.(
      "npm run build",
      {
        onStderr: (chunk) => streamed.push(`stderr:${chunk}`),
        onStdout: (chunk) => streamed.push(`stdout:${chunk}`),
      },
    );

    expect(result).toEqual({
      exitCode: 7,
      stderr: "",
      stdout: "hello\n",
    });
    expect(streamed).toEqual(["stdout:hello\n"]);
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          createPty: expect.objectContaining({
            cwd: "/workspace",
          }),
        },
        {
          sendInput: expect.stringContaining("docker exec"),
        },
      ]),
    );
  });

  it("reuses one long-lived submitted-code container across commands", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.executeSubmittedCode?.("npm run build");
    await handle.workspace.executeSubmittedCode?.("npm test");

    const commandText = calls
      .map((call) => {
        if (
          typeof call === "object" &&
          call !== null &&
          "executeCommand" in call
        ) {
          return String(call.executeCommand);
        }
        if (typeof call === "object" && call !== null && "sendInput" in call) {
          return String(call.sendInput);
        }
        return "";
      })
      .join("\n");

    expect(countOccurrences(commandText, "docker run -d")).toBe(1);
    expect(commandText).toContain("docker image inspect");
    expect(commandText).not.toContain("docker build -t");
    expect(countOccurrences(commandText, "docker exec")).toBe(2);
  });

  it("disconnects active submitted-code commands before deleting the sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyWaitsForDisconnect: true }),
    });
    const handle = await provider.create();

    const execution = handle.workspace.executeSubmittedCode?.("npm run dev");
    await waitForCall(calls, "createPty");
    await handle.destroy();

    await expect(execution).resolves.toMatchObject({ exitCode: 7 });
    expect(calls).toEqual(
      expect.arrayContaining([{ disconnect: true }, { delete: "sandbox_123" }]),
    );
    expect(
      calls.findIndex((call) => "disconnect" in Object(call)),
    ).toBeLessThan(calls.findIndex((call) => "delete" in Object(call)));
  });

  it("controls inner submitted-code container network without changing outer workspace network", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.setSubmittedCodeNetworkAccess?.(true);
    await handle.workspace.setSubmittedCodeNetworkAccess?.(false);

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          executeCommand: expect.stringContaining(
            "docker network connect bridge",
          ),
        },
        {
          executeCommand: expect.stringContaining(
            "docker network disconnect bridge",
          ),
        },
      ]),
    );
    expect(calls).not.toEqual(
      expect.arrayContaining([{ updateNetworkSettings: expect.anything() }]),
    );
  });

  it("blocks submitted-code network when active commands are cancelled", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.setSubmittedCodeNetworkAccess?.(true);
    await handle.workspace.cancelActiveCommands?.();

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          executeCommand: expect.stringContaining(
            "docker network connect bridge",
          ),
        },
        {
          executeCommand: expect.stringContaining(
            "docker network disconnect bridge",
          ),
        },
      ]),
    );
  });

  it("disconnects active submitted-code commands before resealing submitted-code network", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyWaitsForDisconnect: true }),
    });
    const handle = await provider.create();

    await handle.workspace.setSubmittedCodeNetworkAccess?.(true);
    const execution = handle.workspace.executeSubmittedCode?.("bun install");
    await waitForCall(calls, "createPty");
    await handle.workspace.cancelActiveCommands?.();

    await expect(execution).resolves.toMatchObject({ stdout: "hello\n" });
    const disconnectIndex = calls.findIndex(
      (call) => "disconnect" in Object(call),
    );
    const networkDisconnectIndex = calls.findIndex(
      (call) =>
        typeof call === "object" &&
        call !== null &&
        "executeCommand" in call &&
        typeof call.executeCommand === "string" &&
        call.executeCommand.includes("docker network disconnect bridge"),
    );
    expect(disconnectIndex).toBeGreaterThan(-1);
    expect(networkDisconnectIndex).toBeGreaterThan(disconnectIndex);
  });

  it("removes the inner submitted-code container before deleting the Daytona sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.executeSubmittedCode?.("npm run build");
    const destroyStart = calls.length;
    await handle.destroy();

    const removeIndex = calls.findIndex(
      (call) =>
        calls.indexOf(call) >= destroyStart &&
        typeof call === "object" &&
        call !== null &&
        "executeCommand" in call &&
        typeof call.executeCommand === "string" &&
        call.executeCommand.includes("docker rm -f"),
    );
    const deleteIndex = calls.findIndex((call) => "delete" in Object(call));
    expect(removeIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(removeIndex);
  });

  it("still deletes the Daytona sandbox when submitted-code network reseal fails during destroy", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { failSubmittedCodeNetworkDisable: true }),
    });
    const handle = await provider.create();

    await handle.workspace.setSubmittedCodeNetworkAccess?.(true);
    await expect(handle.destroy()).rejects.toThrow(
      "Failed to update submitted-code container network access.",
    );

    expect(calls).toEqual(
      expect.arrayContaining([
        { executeCommand: expect.stringContaining("docker rm -f") },
        { delete: "sandbox_123" },
      ]),
    );
  });

  it("does not mark failed submitted-code container initialization as ready", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { failFirstSubmittedCodeInitialization: true }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.executeSubmittedCode?.("npm run build"),
    ).rejects.toThrow("Failed to initialize submitted-code container");
    await expect(
      handle.workspace.executeSubmittedCode?.("npm run build"),
    ).resolves.toMatchObject({ stdout: "hello\n" });

    const initializationCommands = calls.filter(
      (call) =>
        typeof call === "object" &&
        call !== null &&
        "executeCommand" in call &&
        typeof call.executeCommand === "string" &&
        call.executeCommand.includes("docker run -d"),
    );
    expect(initializationCommands).toHaveLength(2);
  });

  it("does not build the submitted-code image during pipeline execution", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { missingSubmittedCodeImage: true }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.executeSubmittedCode?.("npm run build"),
    ).rejects.toThrow("Submitted-code image");
    expect(
      calls
        .filter(
          (call): call is { executeCommand: string } =>
            typeof call === "object" &&
            call !== null &&
            "executeCommand" in call &&
            typeof call.executeCommand === "string",
        )
        .map((call) => call.executeCommand)
        .join("\n"),
    ).not.toContain("docker build -t");
  });
});

function fakeClient(
  calls: unknown[],
  options: {
    downloadError?: string;
    failFirstSubmittedCodeInitialization?: boolean;
    failSubmittedCodeNetworkDisable?: boolean;
    missingSubmittedCodeImage?: boolean;
    networkError?: Error;
    ptyNeverConnects?: boolean;
    ptyWaitsForDisconnect?: boolean;
  } = {},
) {
  let submittedCodeInitializationFailures = 0;
  const sandbox = {
    fs: {
      async downloadFiles(
        files: Array<{ destination: string; source: string }>,
        timeoutSec?: number,
      ) {
        calls.push({ downloadFiles: { files, timeoutSec } });
        return files.map((file) => ({
          ...(options.downloadError === undefined
            ? {}
            : { error: options.downloadError }),
          source: file.source,
        }));
      },
      async uploadFiles(files: unknown[]) {
        calls.push({ uploadFiles: files });
      },
    },
    id: "sandbox_123",
    async getSignedPreviewUrl(port: number, ttl?: number) {
      calls.push({ getSignedPreviewUrl: { port, ttl } });
      return { url: `https://preview.example.test:${port}` };
    },
    process: {
      async createPty(ptyOptions: {
        id: string;
        cwd?: string;
        envs?: Record<string, string>;
        cols?: number;
        rows?: number;
        onData: (data: Uint8Array) => void;
      }) {
        calls.push({
          createPty: {
            cols: ptyOptions.cols,
            cwd: ptyOptions.cwd,
            envs: ptyOptions.envs,
            id: ptyOptions.id,
            rows: ptyOptions.rows,
          },
        });
        let disconnected = false;
        let resolveDisconnect: (() => void) | undefined;
        const disconnectedPromise = new Promise<void>((resolve) => {
          resolveDisconnect = resolve;
        });
        return {
          async disconnect() {
            if (disconnected) {
              return;
            }
            disconnected = true;
            calls.push({ disconnect: true });
            resolveDisconnect?.();
          },
          async sendInput(data: string | Uint8Array) {
            calls.push({ sendInput: data });
            ptyOptions.onData(new TextEncoder().encode("hello\n"));
            ptyOptions.onData(
              new TextEncoder().encode("\n__MAKEADEMO_EXIT__:7\n"),
            );
          },
          async wait() {
            calls.push({ wait: true });
            if (options.ptyWaitsForDisconnect === true) {
              await disconnectedPromise;
            }
            return { exitCode: 0 };
          },
          async waitForConnection() {
            calls.push({ waitForConnection: true });
            if (options.ptyNeverConnects === true) {
              await new Promise(() => {});
            }
          },
        };
      },
      async createSession(sessionId: string) {
        calls.push({ createSession: sessionId });
      },
      async deleteSession(sessionId: string) {
        calls.push({ deleteSession: sessionId });
      },
      async executeCommand(command: string) {
        calls.push({ executeCommand: command });
        if (
          options.failSubmittedCodeNetworkDisable === true &&
          command.includes("docker network disconnect bridge")
        ) {
          return {
            exitCode: 1,
            result: "",
            stderr: "failed to disable submitted-code network",
          };
        }
        if (
          options.missingSubmittedCodeImage === true &&
          command.includes("docker image inspect")
        ) {
          return {
            exitCode: 1,
            result: "",
            stderr:
              "Submitted-code image makeademo-submitted-code:node-browser is missing from the prepared Daytona workspace image.",
          };
        }
        if (
          options.failFirstSubmittedCodeInitialization === true &&
          command.includes("docker run -d") &&
          submittedCodeInitializationFailures === 0
        ) {
          submittedCodeInitializationFailures += 1;
          return { exitCode: 1, result: "", stderr: "docker failed" };
        }
        return { exitCode: 0, result: "ok" };
      },
      async executeSessionCommand(
        sessionId: string,
        request: {
          command: string;
          runAsync?: boolean;
          suppressInputEcho?: boolean;
        },
      ) {
        calls.push({ executeSessionCommand: { ...request, sessionId } });
        return { cmdId: "cmd_123" };
      },
      async getSessionCommand(sessionId: string, commandId: string) {
        calls.push({ getSessionCommand: { commandId, sessionId } });
        return { exitCode: 7 };
      },
      async getSessionCommandLogs(
        sessionId: string,
        commandId: string,
        onStdout?: (chunk: string) => void,
        onStderr?: (chunk: string) => void,
      ) {
        calls.push({ getSessionCommandLogs: { commandId, sessionId } });
        if (onStdout !== undefined || onStderr !== undefined) {
          onStdout?.("hello");
          onStderr?.("warn");
          return;
        }

        return { stderr: "streamed stderr", stdout: "streamed stdout" };
      },
    },
    async updateNetworkSettings(settings: unknown) {
      calls.push({ updateNetworkSettings: settings });
      if (options.networkError !== undefined) {
        throw options.networkError;
      }
    },
  };

  return {
    async create(input: unknown) {
      calls.push({ create: input });
      return sandbox;
    },
    async delete(input: { id?: string; name?: string }) {
      calls.push({ delete: input.id ?? input.name });
    },
    async get(idOrName: string) {
      calls.push({ get: idOrName });
      return sandbox;
    },
  };
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function waitForCall(calls: unknown[], key: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (calls.some((call) => key in Object(call))) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
