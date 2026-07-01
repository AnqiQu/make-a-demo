import { describe, expect, it, vi } from "vitest";

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
            source: "/workspace/.makeademo/capture/scene.webm",
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
      "Failed to download Daytona sandbox file /workspace/.makeademo/capture/scene.webm: missing file",
    );
  });

  it("uploads workspace artifacts to the Daytona workspace", async () => {
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
          destination: "/workspace/.makeademo/capture/script.ts",
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

  it("fails fast when a Daytona command does not finish", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { executeCommandNeverResolves: true }),
      commandTimeoutMs: 1,
    });
    const handle = await provider.create();

    await expect(handle.workspace.execute("npm ci")).rejects.toThrow(
      "Daytona command did not finish within 1ms.",
    );
    expect(calls).toEqual(
      expect.arrayContaining([{ executeCommand: "npm ci" }]),
    );
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

  it("fails fast when Daytona does not return a preview URL", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { previewNeverResolves: true }),
      previewUrlTimeoutMs: 1,
    });
    const handle = await provider.create();

    await expect(handle.workspace.getPreviewUrl(4173)).rejects.toThrow(
      "Daytona preview URL creation did not finish within 1ms.",
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        { getSignedPreviewUrl: { port: 4173, ttl: 3600 } },
      ]),
    );
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
      expect(command).not.toContain("/tmp/makeademo/submitted-code");
    }
    expect(
      calls.filter(
        (call) =>
          typeof call === "object" && call !== null && "createSession" in call,
      ),
    ).toHaveLength(0);
  });

  it("keeps sandbox log write timeouts host-visible without failing callers", async () => {
    const calls: unknown[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { executeCommandNeverResolves: true }),
      logWriteTimeoutMs: 1,
    });
    const handle = await provider.create();

    try {
      await expect(
        handle.workspace.writeSandboxLog?.({
          event: "project-validation.started",
          stage: "project-validation",
        }),
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(
        "Pipeline log sink write failed.",
        expect.objectContaining({
          message: "Daytona sandbox log write did not finish within 1ms.",
        }),
      );
    } finally {
      warn.mockRestore();
    }
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

  it("relays sandbox logs to configured sinks", async () => {
    const calls: unknown[] = [];
    const relayedLogs: string[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
      sandboxLogSinks: [
        {
          write(line) {
            relayedLogs.push(line);
          },
        },
      ],
    });
    const handle = await provider.create();

    await handle.workspace.writeSandboxLog?.({
      event: "project-validation.dependency-install.started",
      stage: "project-validation",
      workspaceId: "workspace_123",
    });

    expect(relayedLogs).toHaveLength(1);
    expect(JSON.parse(relayedLogs[0] ?? "{}")).toMatchObject({
      component: "daytona-sandbox",
      event: "project-validation.dependency-install.started",
      message: "project-validation.dependency-install.started",
      stage: "project-validation",
      workspaceId: "workspace_123",
    });
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

  it("creates a linked ephemeral submitted-code sandbox when configured", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      snapshot: "makeademo-opencode",
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });

    const handle = await provider.create();

    expect(handle.id).toBe("parent_sandbox");
    expect(calls.slice(0, 2)).toEqual([
      {
        create: {
          disk: 3,
          snapshot: "makeademo-opencode",
        },
      },
      {
        create: {
          autoDeleteInterval: 0,
          ephemeral: true,
          linkedSandbox: "parent_sandbox",
          networkBlockAll: true,
          snapshot: "makeademo-submitted-code-browser",
        },
      },
    ]);
  });

  it("routes submitted-code execution, network, preview, and uploads through the linked child sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await handle.workspace.uploadFiles([
      {
        destinationPath: "/workspace/package.json",
        sourcePath: "/tmp/repo/package.json",
      },
    ]);
    const result = await handle.workspace.executeSubmittedCode?.("npm test");
    await handle.workspace.setSubmittedCodeNetworkAccess?.(true);
    await expect(handle.workspace.getPreviewUrl(3000)).resolves.toBe(
      "https://child-preview.example.test:3000",
    );

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "child ok" });
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          uploadFiles: {
            files: [
              {
                destination: "/workspace/package.json",
                source: "/tmp/repo/package.json",
              },
            ],
            sandbox: "parent_sandbox",
          },
        },
        {
          uploadFiles: {
            files: [
              {
                destination: "/workspace/package.json",
                source: "/tmp/repo/package.json",
              },
            ],
            sandbox: "submitted_sandbox",
          },
        },
        {
          executeCommand: { command: "npm test", sandbox: "submitted_sandbox" },
        },
        {
          updateNetworkSettings: {
            sandbox: "submitted_sandbox",
            settings: { networkBlockAll: false },
          },
        },
        {
          getSignedPreviewUrl: {
            port: 3000,
            sandbox: "submitted_sandbox",
            ttl: 3600,
          },
        },
      ]),
    );
  });

  it("syncs prepared parent workspace files into the linked submitted-code sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await handle.workspace.syncSubmittedCodeWorkspace?.();

    expect(calls).toContainEqual({
      executeCommand: {
        command: expect.stringContaining("./.git"),
        sandbox: "parent_sandbox",
      },
    });
    expect(calls).toContainEqual({
      executeCommand: {
        command: expect.stringContaining("./*/node_modules/*"),
        sandbox: "parent_sandbox",
      },
    });
    const archiveCommand = calls.find(
      (
        call,
      ): call is { executeCommand: { command: string; sandbox: string } } =>
        typeof call === "object" &&
        call !== null &&
        "executeCommand" in call &&
        typeof call.executeCommand === "object" &&
        call.executeCommand !== null &&
        "command" in call.executeCommand &&
        typeof call.executeCommand.command === "string" &&
        call.executeCommand.command.includes("tar ") &&
        call.executeCommand.command.includes("-czf"),
    )?.executeCommand.command;
    expect(archiveCommand).toEqual(expect.stringContaining("./.vite/*"));
    expect(archiveCommand).toEqual(expect.stringContaining("./*/.turbo/*"));
    expect(archiveCommand).toEqual(expect.stringContaining("./.npm/*"));
    expect(archiveCommand).toEqual(
      expect.stringContaining("./*/.pnpm-store/*"),
    );
    expect(archiveCommand).toEqual(expect.stringContaining("./.yarn/cache/*"));
    expect(archiveCommand).toEqual(
      expect.stringContaining("./*/.next/cache/*"),
    );
    expect(archiveCommand).not.toContain("./.makeademo");
    expect(calls).toContainEqual({
      downloadFiles: {
        files: [
          {
            destination: expect.stringContaining("makeademo-daytona-sync-"),
            source: expect.stringContaining(
              "/tmp/makeademo/prepared-workspace-",
            ),
          },
        ],
        sandbox: "parent_sandbox",
        timeoutSec: 0,
      },
    });
    expect(calls).toContainEqual({
      uploadFiles: {
        files: [
          {
            destination: expect.stringContaining(
              "/tmp/makeademo/prepared-workspace-",
            ),
            source: expect.stringContaining("makeademo-daytona-sync-"),
          },
        ],
        sandbox: "submitted_sandbox",
      },
    });
    expect(calls).toContainEqual({
      executeCommand: {
        command: expect.stringContaining("tar -xzf"),
        sandbox: "submitted_sandbox",
      },
    });
    const restoreCommand = calls.find(
      (
        call,
      ): call is { executeCommand: { command: string; sandbox: string } } =>
        typeof call === "object" &&
        call !== null &&
        "executeCommand" in call &&
        typeof call.executeCommand === "object" &&
        call.executeCommand !== null &&
        "command" in call.executeCommand &&
        "sandbox" in call.executeCommand &&
        typeof call.executeCommand.command === "string" &&
        call.executeCommand.sandbox === "submitted_sandbox" &&
        call.executeCommand.command.includes("tar -xzf"),
    )?.executeCommand.command;
    expect(restoreCommand).toEqual(expect.stringContaining("node_modules"));
    expect(restoreCommand).toEqual(expect.stringContaining(".vite"));
    expect(restoreCommand).toEqual(expect.stringContaining(".turbo"));
    expect(restoreCommand).toEqual(expect.stringContaining(".npm"));
    expect(restoreCommand).toEqual(expect.stringContaining(".pnpm-store"));
    expect(restoreCommand).toEqual(expect.stringContaining(".yarn/cache"));
    expect(restoreCommand).toEqual(expect.stringContaining(".next/cache"));
    expect(restoreCommand).toEqual(expect.stringContaining(".bun"));
    expect(restoreCommand).toEqual(expect.stringContaining(".cache"));
    expect(restoreCommand).toEqual(
      expect.stringContaining(
        '{ cp -a "$preserved"/. /workspace/ 2>/dev/null || true; }',
      ),
    );
    expect(restoreCommand).toEqual(
      expect.stringContaining("preserved_paths=$(mktemp)"),
    );
    expect(restoreCommand).toEqual(
      expect.stringContaining('> "$preserved_paths"'),
    );
    expect(restoreCommand).toEqual(
      expect.stringContaining('done < "$preserved_paths"'),
    );
    expect(restoreCommand).toEqual(expect.stringContaining("mkdir -p"));
    expect(restoreCommand).toEqual(
      expect.stringContaining('mv -- "$path" "$preserved/$relative" || exit 1'),
    );
    expect(restoreCommand).toEqual(expect.stringContaining(" || exit 1"));
    expect(restoreCommand).not.toContain("| while");
    expect(restoreCommand).not.toMatch(/&& cp -a .* \|\| true && tar -xzf/);
    expect(restoreCommand).not.toContain(
      "find /workspace -mindepth 1 -exec rm -rf {} +",
    );
  });

  it("reports parent archive stdout, stderr, and exit code when archiving prepared files fails", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        failParentArchive: true,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.syncSubmittedCodeWorkspace?.(),
    ).rejects.toThrow(
      "Failed to archive prepared Daytona workspace (exit code 8). stderr: tar: permission denied stdout: archive started",
    );
  });

  it("reports submitted-code restore stderr when extracting prepared files fails", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        failSubmittedRestore: true,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.syncSubmittedCodeWorkspace?.(),
    ).rejects.toThrow(
      "Failed to restore prepared files in submitted-code sandbox (exit code 9). stderr: tar: corrupt archive stdout: restore started",
    );
  });

  it("fails sync when Daytona archive transfer hangs without waiting for remote cleanup", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        downloadFilesNeverResolves: true,
        remoteCleanupNeverResolves: true,
      }),
      commandTimeoutMs: 1,
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.syncSubmittedCodeWorkspace?.(),
    ).rejects.toThrow(
      "Daytona prepared workspace archive download did not finish within 1ms.",
    );

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          executeCommand: {
            command: expect.stringContaining("rm -f"),
            sandbox: "parent_sandbox",
          },
        },
        {
          executeCommand: {
            command: expect.stringContaining("rm -f"),
            sandbox: "submitted_sandbox",
          },
        },
      ]),
    );
  });

  it("deletes the linked submitted-code sandbox before deleting the parent sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await handle.destroy();

    expect(calls.slice(-2)).toEqual([
      { delete: "submitted_sandbox" },
      { delete: "parent_sandbox" },
    ]);
  });
});

function fakeLinkedClient(
  calls: unknown[],
  options: {
    downloadFilesNeverResolves?: boolean;
    failParentArchive?: boolean;
    failSubmittedRestore?: boolean;
    remoteCleanupNeverResolves?: boolean;
  } = {},
) {
  const parentSandbox = fakeLinkedSandbox(
    calls,
    "parent_sandbox",
    "parent ok",
    options,
  );
  const childSandbox = fakeLinkedSandbox(
    calls,
    "submitted_sandbox",
    "child ok",
    options,
  );

  return {
    async create(input: unknown) {
      calls.push({ create: input });
      if (
        typeof input === "object" &&
        input !== null &&
        "linkedSandbox" in input
      ) {
        return childSandbox;
      }

      return parentSandbox;
    },
    async delete(input: { id?: string; name?: string }) {
      calls.push({ delete: input.id ?? input.name });
    },
  };
}

function fakeLinkedSandbox(
  calls: unknown[],
  id: string,
  stdout: string,
  options: {
    downloadFilesNeverResolves?: boolean;
    failParentArchive?: boolean;
    failSubmittedRestore?: boolean;
    remoteCleanupNeverResolves?: boolean;
  } = {},
) {
  return {
    fs: {
      async downloadFiles(
        files: Array<{ destination: string; source: string }>,
        timeoutSec?: number,
      ) {
        calls.push({ downloadFiles: { files, sandbox: id, timeoutSec } });
        if (options.downloadFilesNeverResolves === true) {
          await new Promise(() => {});
        }
        return files.map((file) => ({ source: file.source }));
      },
      async uploadFiles(files: unknown[]) {
        calls.push({ uploadFiles: { files, sandbox: id } });
      },
    },
    id,
    async getSignedPreviewUrl(port: number, ttl?: number) {
      calls.push({ getSignedPreviewUrl: { port, sandbox: id, ttl } });
      return {
        url: `https://${id === "submitted_sandbox" ? "child" : "parent"}-preview.example.test:${port}`,
      };
    },
    process: {
      async createPty() {
        throw new Error("Streaming is not exercised by linked sandbox tests.");
      },
      async createSession() {},
      async deleteSession() {},
      async executeCommand(command: string) {
        calls.push({ executeCommand: { command, sandbox: id } });
        if (
          options.failParentArchive === true &&
          id === "parent_sandbox" &&
          command.includes("tar ") &&
          command.includes("-czf")
        ) {
          return {
            exitCode: 8,
            result: "archive started",
            stderr: "tar: permission denied",
          };
        }
        if (
          options.failSubmittedRestore === true &&
          id === "submitted_sandbox" &&
          command.includes("tar -xzf")
        ) {
          return {
            exitCode: 9,
            result: "restore started",
            stderr: "tar: corrupt archive",
          };
        }
        if (
          options.remoteCleanupNeverResolves === true &&
          command.includes("rm -f")
        ) {
          await new Promise(() => {});
        }
        return { exitCode: 0, result: stdout };
      },
      async executeSessionCommand() {
        return { cmdId: "cmd_123" };
      },
      async getSessionCommand() {
        return { exitCode: 0 };
      },
      async getSessionCommandLogs() {
        return { stderr: "", stdout: "" };
      },
    },
    async updateNetworkSettings(settings: unknown) {
      calls.push({ updateNetworkSettings: { sandbox: id, settings } });
    },
  };
}

function fakeClient(
  calls: unknown[],
  options: {
    downloadError?: string;
    executeCommandNeverResolves?: boolean;
    failFirstSubmittedCodeInitialization?: boolean;
    failSubmittedCodeNetworkDisable?: boolean;
    missingSubmittedCodeImage?: boolean;
    networkError?: Error;
    previewNeverResolves?: boolean;
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
      if (options.previewNeverResolves === true) {
        await new Promise(() => {});
      }
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
        if (options.executeCommandNeverResolves === true) {
          await new Promise(() => {});
        }
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
