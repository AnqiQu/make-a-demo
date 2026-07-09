import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  DaytonaSdkPreparationWorkspaceProvider,
  createDaytonaSdkPreparationWorkspaceHandle,
} from "./daytona-sdk-preparation-workspace-provider";

const execFileAsync = promisify(execFile);

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

  it("uses a bounded Daytona sandbox create timeout", async () => {
    const calls: unknown[] = [];
    const sandbox = fakeLinkedSandbox(calls, "sandbox_123", "ok");
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create(input: unknown, options?: unknown) {
          calls.push({ create: input, options });
          return sandbox;
        },
        async delete(input: { id?: string; name?: string }) {
          calls.push({ delete: input.id ?? input.name });
        },
      } as never,
      sandboxCreateTimeoutSeconds: 180,
    });

    await provider.create();

    expect(calls[0]).toEqual({
      create: { disk: 3 },
      options: { timeout: 180 },
    });
  });

  it("retries transient Daytona connection failures while creating a sandbox", async () => {
    const calls: unknown[] = [];
    const sandbox = fakeLinkedSandbox(calls, "sandbox_123", "ok");
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create(input: unknown, options?: unknown) {
          calls.push({ create: input, options });
          if (calls.filter((call) => "create" in Object(call)).length === 1) {
            const error = new Error("ECONNREFUSED");
            error.name = "DaytonaConnectionError";
            throw error;
          }

          return sandbox;
        },
        async delete(input: { id?: string; name?: string }) {
          calls.push({ delete: input.id ?? input.name });
        },
      } as never,
      sandboxCreateTimeoutSeconds: 180,
    });

    const handle = await provider.create();

    expect(handle.id).toBe("sandbox_123");
    expect(calls.slice(0, 2)).toEqual([
      { create: { disk: 3 }, options: { timeout: 180 } },
      { create: { disk: 3 }, options: { timeout: 180 } },
    ]);
  });

  it("attaches configured Daytona secrets to the parent sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
      secrets: { OPENAI_API_KEY: "makeademo-openai" },
    });

    await provider.create();

    expect(calls[0]).toEqual({
      create: {
        disk: 3,
        secrets: { OPENAI_API_KEY: "makeademo-openai" },
      },
    });
  });

  it("uploads screened workspace files with Daytona fs.uploadFiles", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.uploadFiles?.([
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

    await handle.workspace.uploadFiles?.([
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
    await handle.workspace.setOutboundNetworkAccess?.(false);
    await handle.destroy();

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ok" });
    expect(calls.slice(1)).toEqual([
      { executeCommand: "opencode run hello" },
      { updateNetworkSettings: { networkBlockAll: true } },
      { delete: "sandbox_123" },
    ]);
  });

  it("passes the configured command timeout to parent Daytona commands", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      commandTimeoutMs: 1_500,
    });
    const handle = await provider.create();

    await handle.workspace.execute("npm ci", { env: { CI: "true" } });

    expect(calls).toContainEqual({
      executeCommand: {
        command: "npm ci",
        cwd: undefined,
        env: { CI: "true" },
        sandbox: "parent_sandbox",
        timeout: 2,
      },
    });
  });

  it("lets each command override the provider timeout", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      commandTimeoutMs: 10_000,
    });
    const handle = await provider.create();

    await handle.workspace.execute("opencode run", { timeoutMs: 1_500 });

    expect(calls).toContainEqual({
      executeCommand: {
        command: "opencode run",
        cwd: undefined,
        env: undefined,
        sandbox: "parent_sandbox",
        timeout: 2,
      },
    });
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

    await expect(handle.workspace.getPreviewUrl?.(4173)).resolves.toBe(
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

    await expect(handle.workspace.getPreviewUrl?.(4173)).rejects.toThrow(
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
          call.executeCommand.includes("printf '%s'") &&
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

  it("collects durable sandbox log lines before teardown", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        sandboxLogContents:
          '{"event":"agent.started"}\n{"event":"agent.failed"}\n',
      }),
    });
    const handle = await provider.create();

    await expect(handle.workspace.collectSandboxLogs?.()).resolves.toEqual([
      '{"event":"agent.started"}',
      '{"event":"agent.failed"}',
    ]);
  });

  it("does not resolve sandbox logging until the workspace-visible mirror is durable", async () => {
    const calls: unknown[] = [];
    const workspaceMirrorStarted = deferred<void>();
    const workspaceMirror = deferred<void>();
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        awaitWorkspaceLogMirror: workspaceMirror.promise,
        onWorkspaceLogMirrorStarted: workspaceMirrorStarted.resolve,
      }),
    });
    const handle = await provider.create();

    let resolved = false;
    const write = handle.workspace
      .writeSandboxLog?.({
        event: "repo-preparation.started",
        stage: "repo-preparation",
      })
      .then(() => {
        resolved = true;
      });

    await workspaceMirrorStarted.promise;

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          executeCommand: expect.stringContaining(
            "cp '/tmp/makeademo/sandbox-log.jsonl' '/workspace/.makeademo/sandbox-log.jsonl'",
          ),
        },
      ]),
    );
    expect(resolved).toBe(false);

    workspaceMirror.resolve();
    await expect(write).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it("surfaces sandbox logging failures when the workspace mirror path is unavailable", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { failWorkspaceLogMirror: true }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.writeSandboxLog?.({
        event: "repo-preparation.started",
        stage: "repo-preparation",
      }),
    ).rejects.toThrow("Failed to mirror Daytona sandbox audit log.");

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          executeCommand: expect.stringContaining(
            ">> '/tmp/makeademo/sandbox-log.jsonl'",
          ),
        },
        {
          executeCommand: expect.stringContaining(
            "cp '/tmp/makeademo/sandbox-log.jsonl' '/workspace/.makeademo/sandbox-log.jsonl'",
          ),
        },
      ]),
    );
  });

  it("fails fast when a durable sandbox log write does not finish", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { executeCommandNeverResolves: true }),
      logWriteTimeoutMs: 1,
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.writeSandboxLog?.({
        event: "project-validation.started",
        stage: "project-validation",
      }),
    ).rejects.toThrow("Daytona sandbox log write did not finish within 1ms.");
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

  it("disconnects and rejects a streaming command at its per-command timeout", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyWaitsForDisconnect: true }),
      commandTimeoutMs: 10_000,
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("opencode run slow", {
        onStdout: () => {},
        timeoutMs: 1,
      }),
    ).rejects.toThrow("Daytona command did not finish within 1ms.");
    expect(calls).toContainEqual({ disconnect: true });
  });

  it("passes streaming command environment variables through PTY options", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.execute("opencode run hello", {
      env: { OPENCODE_CONFIG_DIR: "/tmp/makeademo/opencode" },
      onStdout: () => {},
    });

    expect(calls[1]).toEqual({
      createPty: expect.objectContaining({
        envs: { OPENCODE_CONFIG_DIR: "/tmp/makeademo/opencode" },
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

  it("retries streaming PTY startup before sending the command", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyConnectionFailuresBeforeSuccess: 1 }),
      ptyConnectionTimeoutMs: 1,
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("opencode run hello", {
      onStdout: () => {},
    });

    expect(result).toMatchObject({ exitCode: 7, stdout: "hello\n" });
    expect(calls.filter((call) => "createPty" in Object(call))).toHaveLength(2);
    expect(
      calls.filter((call) => "waitForConnection" in Object(call)),
    ).toHaveLength(2);
    expect(calls.filter((call) => "sendInput" in Object(call))).toHaveLength(1);
  });

  it("retries streaming PTY startup with a fresh id after stale duplicate-id creation", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyStaleDuplicateIdOnFirstCreate: true }),
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("opencode run hello", {
      onStdout: () => {},
    });

    const ptyIds = calls
      .filter(
        (call): call is { createPty: { id: string } } =>
          typeof call === "object" &&
          call !== null &&
          "createPty" in call &&
          typeof call.createPty === "object" &&
          call.createPty !== null &&
          "id" in call.createPty &&
          typeof call.createPty.id === "string",
      )
      .map((call) => call.createPty.id);
    expect(result).toMatchObject({ exitCode: 7, stdout: "hello\n" });
    expect(ptyIds).toHaveLength(2);
    expect(ptyIds[1]).not.toBe(ptyIds[0]);
    expect(calls.filter((call) => "sendInput" in Object(call))).toHaveLength(1);
  });

  it("does not retry streaming PTY failures after sending the command", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyWaitFails: true }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("opencode run hello", { onStdout: () => {} }),
    ).rejects.toThrow("PTY wait failed after command started.");

    expect(calls.filter((call) => "createPty" in Object(call))).toHaveLength(1);
    expect(calls.filter((call) => "sendInput" in Object(call))).toHaveLength(1);
  });

  it("does not retry non-PTY command failures", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { executeCommandFails: true }),
    });
    const handle = await provider.create();

    await expect(handle.workspace.execute("npm test")).rejects.toThrow(
      "executeCommand failed",
    );

    expect(
      calls.filter(
        (call) =>
          typeof call === "object" && call !== null && "executeCommand" in call,
      ),
    ).toHaveLength(1);
  });

  it("fails cleanly when streaming PTY startup retries are exhausted", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyConnectionFailuresBeforeSuccess: 99 }),
      ptyConnectionTimeoutMs: 1,
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("opencode run hello", { onStdout: () => {} }),
    ).rejects.toThrow("Daytona PTY did not connect within 1ms.");

    expect(calls.filter((call) => "createPty" in Object(call))).toHaveLength(3);
    expect(calls.filter((call) => "sendInput" in Object(call))).toHaveLength(0);
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
      handle.workspace.setOutboundNetworkAccess?.(true),
    ).resolves.toBeUndefined();
    await expect(
      handle.workspace.setOutboundNetworkAccess?.(false),
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
    expect(handle.workspace.agentSandboxId).toBe("parent_sandbox");
    expect(handle.workspace.submittedCodeSandboxId).toBe("submitted_sandbox");
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

  it("deletes the parent sandbox when linked submitted-code sandbox creation fails", async () => {
    const calls: unknown[] = [];
    const parentSandbox = fakeLinkedSandbox(
      calls,
      "parent_sandbox",
      "parent ok",
    );
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create(input: unknown) {
          calls.push({ create: input });
          if (
            typeof input === "object" &&
            input !== null &&
            "linkedSandbox" in input
          ) {
            throw new Error("linked create timed out");
          }

          return parentSandbox;
        },
        async delete(input: { id?: string; name?: string }) {
          calls.push({ delete: input.id ?? input.name });
        },
      },
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });

    await expect(provider.create()).rejects.toThrow("linked create timed out");
    expect(calls).toEqual(
      expect.arrayContaining([{ delete: "parent_sandbox" }]),
    );
  });

  it("does not attach parent Daytona secrets to the linked submitted-code sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      secrets: { OPENAI_API_KEY: "makeademo-openai" },
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });

    await provider.create();

    expect(calls.slice(0, 2)).toEqual([
      {
        create: {
          disk: 3,
          secrets: { OPENAI_API_KEY: "makeademo-openai" },
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

  it("routes submitted-code execution, network, preview, and artifacts through the linked child sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await handle.workspace.uploadFiles?.([
      {
        destinationPath: "/workspace/package.json",
        sourcePath: "/tmp/repo/package.json",
      },
    ]);
    await handle.workspace.downloadFiles?.([
      {
        destinationPath: "/tmp/capture.webm",
        sourcePath: "/workspace/.makeademo/capture.webm",
      },
    ]);
    const result = await handle.workspace.executeSubmittedCode?.("npm test");
    await handle.workspace.setSubmittedCodeNetworkAccess?.(true);
    const networkTransitions =
      await handle.workspace.collectNetworkStateLog?.();
    await expect(handle.workspace.getPreviewUrl?.(3000)).resolves.toBe(
      "https://child-preview.example.test:3000",
    );

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "child ok" });
    expect(networkTransitions?.map((transition) => transition.state)).toEqual([
      "runtime-locked",
      "dependency-install-open",
    ]);
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
          downloadFiles: {
            files: [
              {
                destination: "/tmp/capture.webm",
                source: "/workspace/.makeademo/capture.webm",
              },
            ],
            sandbox: "submitted_sandbox",
            timeoutSec: 0,
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

  it("manages the submitted app through a Daytona process session", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await handle.workspace.startSubmittedCodeApp?.({
      command: "npm run dev -- --host 0.0.0.0",
      cwd: "/workspace/repo with spaces",
      env: { DEMO_MODE: "customer's demo" },
    });
    const status = await handle.workspace.readSubmittedCodeAppStatus?.();
    await handle.workspace.stopSubmittedCodeApp?.();

    const session = calls.find(
      (
        call,
      ): call is { createSession: { sandbox: string; sessionId: string } } =>
        typeof call === "object" && call !== null && "createSession" in call,
    )?.createSession;
    expect(session).toEqual({
      sandbox: "submitted_sandbox",
      sessionId: expect.stringMatching(/^makeademo-app-/),
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          executeSessionCommand: {
            command: expect.stringContaining(
              "cd '/workspace/repo with spaces' && env 'DEMO_MODE=customer'\\''s demo' sh -lc 'npm run dev -- --host 0.0.0.0'",
            ),
            runAsync: true,
            sandbox: "submitted_sandbox",
            sessionId: session?.sessionId,
            suppressInputEcho: true,
          },
        },
        {
          getSessionCommand: {
            commandId: "cmd_123",
            sandbox: "submitted_sandbox",
            sessionId: session?.sessionId,
          },
        },
        {
          getSessionCommandLogs: {
            commandId: "cmd_123",
            sandbox: "submitted_sandbox",
            sessionId: session?.sessionId,
          },
        },
        {
          deleteSession: {
            sandbox: "submitted_sandbox",
            sessionId: session?.sessionId,
          },
        },
      ]),
    );
    expect(status).toEqual({
      exitCode: 0,
      running: false,
      stderr: "",
      stdout: "",
    });
  });

  it("passes the configured command timeout to submitted-code Daytona commands", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      commandTimeoutMs: 1_500,
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await handle.workspace.executeSubmittedCode?.("npm test", {
      env: { NODE_ENV: "test" },
    });

    expect(calls).toContainEqual({
      executeCommand: {
        command: "npm test",
        cwd: undefined,
        env: { NODE_ENV: "test" },
        sandbox: "submitted_sandbox",
        timeout: 2,
      },
    });
  });

  it("fails fast when non-stream submitted-code execution does not finish", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, { executeCommandNeverResolves: true }),
      commandTimeoutMs: 1,
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.executeSubmittedCode?.("npm ci"),
    ).rejects.toThrow("Daytona command did not finish within 1ms.");

    expect(calls).toEqual(
      expect.arrayContaining([
        {
          executeCommand: { command: "npm ci", sandbox: "submitted_sandbox" },
        },
      ]),
    );
  });

  it("syncs prepared parent workspace files into the linked submitted-code sandbox while excluding generated artifacts", async () => {
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
    expect(archiveCommand).toEqual(expect.stringContaining("./.makeademo"));
    expect(archiveCommand).toEqual(expect.stringContaining("./.makeademo/*"));
    expect(archiveCommand).toEqual(expect.stringContaining("-C /workspace ."));
    expect(archiveCommand).not.toEqual(
      expect.stringContaining("--exclude='./*'"),
    );
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

  it("escapes submitted-code restore find grouping for the sandbox shell", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await handle.workspace.syncSubmittedCodeWorkspace?.();

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

    expect(restoreCommand).toEqual(
      expect.stringContaining("find /workspace -mindepth 1 \\( "),
    );
    expect(restoreCommand).toEqual(
      expect.stringContaining(" \\) -prune -print"),
    );
  });

  it("restores submitted-code workspace through a POSIX shell while preserving caches and excluding MakeADemo artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-daytona-shell-"));
    const parentWorkspace = join(root, "parent");
    const submittedWorkspace = join(root, "submitted");
    const calls: unknown[] = [];
    await mkdir(join(parentWorkspace, ".makeademo"), { recursive: true });
    await mkdir(join(parentWorkspace, "node_modules"), { recursive: true });
    await mkdir(join(submittedWorkspace, "node_modules"), { recursive: true });
    await writeFile(join(parentWorkspace, "package.json"), "prepared app");
    await writeFile(
      join(parentWorkspace, ".makeademo", "capture.webm"),
      "generated artifact",
    );
    await writeFile(
      join(parentWorkspace, "node_modules", "prepared-cache.txt"),
      "must stay excluded",
    );
    await writeFile(
      join(submittedWorkspace, "node_modules", "preserved-cache.txt"),
      "keep me",
    );
    await writeFile(join(submittedWorkspace, "stale.txt"), "remove me");
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLocalShellLinkedClient(calls, {
        parentWorkspace,
        submittedWorkspace,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });

    try {
      const handle = await provider.create();

      await handle.workspace.syncSubmittedCodeWorkspace?.();

      await expect(
        readFile(join(submittedWorkspace, "package.json"), "utf8"),
      ).resolves.toBe("prepared app");
      await expect(
        readFile(
          join(submittedWorkspace, "node_modules", "preserved-cache.txt"),
          "utf8",
        ),
      ).resolves.toBe("keep me");
      await expectPathMissing(
        join(submittedWorkspace, "node_modules", "prepared-cache.txt"),
      );
      await expectPathMissing(join(submittedWorkspace, ".makeademo"));
      await expectPathMissing(join(submittedWorkspace, "stale.txt"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
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
    executeCommandNeverResolves?: boolean;
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

function fakeCommandTimeoutClient(calls: unknown[]) {
  const parentSandbox = fakeCommandTimeoutSandbox(calls, "parent_sandbox");
  const childSandbox = fakeCommandTimeoutSandbox(calls, "submitted_sandbox");

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

function fakeCommandTimeoutSandbox(calls: unknown[], id: string) {
  return {
    fs: {
      async downloadFiles(
        files: Array<{ destination: string; source: string }>,
      ) {
        return files.map((file) => ({ source: file.source }));
      },
      async uploadFiles() {},
    },
    id,
    async getSignedPreviewUrl(port: number) {
      return { url: `https://${id}.example.test:${port}` };
    },
    process: {
      async createPty() {
        throw new Error("Streaming is not exercised by command timeout tests.");
      },
      async createSession(sessionId: string) {
        calls.push({ createSession: { sandbox: id, sessionId } });
      },
      async deleteSession(sessionId: string) {
        calls.push({ deleteSession: { sandbox: id, sessionId } });
      },
      async executeCommand(
        command: string,
        cwd?: string,
        env?: Record<string, string>,
        timeout?: number,
      ) {
        calls.push({
          executeCommand: { command, cwd, env, sandbox: id, timeout },
        });
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
        calls.push({
          executeSessionCommand: { ...request, sandbox: id, sessionId },
        });
        return { cmdId: "cmd_123" };
      },
      async getSessionCommand(sessionId: string, commandId: string) {
        calls.push({
          getSessionCommand: { commandId, sandbox: id, sessionId },
        });
        return { exitCode: 0 };
      },
      async getSessionCommandLogs(sessionId: string, commandId: string) {
        calls.push({
          getSessionCommandLogs: { commandId, sandbox: id, sessionId },
        });
        return { stderr: "", stdout: "" };
      },
    },
    async updateNetworkSettings() {},
  };
}

function fakeLocalShellLinkedClient(
  calls: unknown[],
  workspaces: { parentWorkspace: string; submittedWorkspace: string },
) {
  const parentSandbox = fakeLocalShellSandbox(
    calls,
    "parent_sandbox",
    workspaces.parentWorkspace,
  );
  const childSandbox = fakeLocalShellSandbox(
    calls,
    "submitted_sandbox",
    workspaces.submittedWorkspace,
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

function fakeLocalShellSandbox(
  calls: unknown[],
  id: string,
  workspacePath: string,
) {
  return {
    fs: {
      async downloadFiles(
        files: Array<{ destination: string; source: string }>,
        timeoutSec?: number,
      ) {
        calls.push({ downloadFiles: { files, sandbox: id, timeoutSec } });
        for (const file of files) {
          await mkdir(dirname(file.destination), { recursive: true });
          await copyFile(file.source, file.destination);
        }
        return files.map((file) => ({ source: file.source }));
      },
      async uploadFiles(files: Array<{ destination: string; source: string }>) {
        calls.push({ uploadFiles: { files, sandbox: id } });
        for (const file of files) {
          await mkdir(dirname(file.destination), { recursive: true });
          await copyFile(file.source, file.destination);
        }
      },
    },
    id,
    async getSignedPreviewUrl(port: number) {
      return { url: `https://local-shell.example.test:${port}` };
    },
    process: {
      async createPty() {
        throw new Error("Streaming is not exercised by local shell tests.");
      },
      async createSession() {},
      async deleteSession() {},
      async executeCommand(command: string) {
        calls.push({ executeCommand: { command, sandbox: id } });
        return runLocalWorkspaceCommand(command, workspacePath);
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
    async updateNetworkSettings() {},
  };
}

async function runLocalWorkspaceCommand(
  command: string,
  workspacePath: string,
): Promise<{ exitCode: number; result: string; stderr: string }> {
  try {
    const result = await execFileAsync(
      "/bin/sh",
      ["-c", command.replaceAll("/workspace", workspacePath)],
      { timeout: 5_000 },
    );
    return { exitCode: 0, result: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stderr?: string;
      stdout?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      result: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
    };
  }
}

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

function fakeLinkedSandbox(
  calls: unknown[],
  id: string,
  stdout: string,
  options: {
    downloadFilesNeverResolves?: boolean;
    executeCommandNeverResolves?: boolean;
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
      async createSession(sessionId: string) {
        calls.push({ createSession: { sandbox: id, sessionId } });
      },
      async deleteSession(sessionId: string) {
        calls.push({ deleteSession: { sandbox: id, sessionId } });
      },
      async executeCommand(command: string) {
        calls.push({ executeCommand: { command, sandbox: id } });
        if (options.executeCommandNeverResolves === true) {
          await new Promise(() => {});
        }
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
      async executeSessionCommand(
        sessionId: string,
        request: {
          command: string;
          runAsync?: boolean;
          suppressInputEcho?: boolean;
        },
      ) {
        calls.push({
          executeSessionCommand: { ...request, sandbox: id, sessionId },
        });
        return { cmdId: "cmd_123" };
      },
      async getSessionCommand(sessionId: string, commandId: string) {
        calls.push({
          getSessionCommand: { commandId, sandbox: id, sessionId },
        });
        return { exitCode: 0 };
      },
      async getSessionCommandLogs(sessionId: string, commandId: string) {
        calls.push({
          getSessionCommandLogs: { commandId, sandbox: id, sessionId },
        });
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
    awaitWorkspaceLogMirror?: Promise<void>;
    downloadError?: string;
    executeCommandFails?: boolean;
    executeCommandNeverResolves?: boolean;
    failFirstSubmittedCodeInitialization?: boolean;
    failWorkspaceLogMirror?: boolean;
    failSubmittedCodeNetworkDisable?: boolean;
    missingSubmittedCodeImage?: boolean;
    networkError?: Error;
    onWorkspaceLogMirrorStarted?: () => void;
    previewNeverResolves?: boolean;
    ptyConnectionFailuresBeforeSuccess?: number;
    ptyNeverConnects?: boolean;
    ptyStaleDuplicateIdOnFirstCreate?: boolean;
    ptyWaitFails?: boolean;
    ptyWaitsForDisconnect?: boolean;
    sandboxLogContents?: string;
  } = {},
) {
  let submittedCodeInitializationFailures = 0;
  let ptyConnectionFailures = 0;
  const stalePtyIds = new Set<string>();
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
        if (options.ptyStaleDuplicateIdOnFirstCreate === true) {
          if (stalePtyIds.size === 0) {
            stalePtyIds.add(ptyOptions.id);
            throw new Error("PTY session with ID already exists.");
          }
          if (stalePtyIds.has(ptyOptions.id)) {
            throw new Error("PTY session with ID already exists.");
          }
        }
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
            if (options.ptyWaitFails === true) {
              throw new Error("PTY wait failed after command started.");
            }
            if (options.ptyWaitsForDisconnect === true) {
              await disconnectedPromise;
            }
            return { exitCode: 0 };
          },
          async waitForConnection() {
            calls.push({ waitForConnection: true });
            if (
              ptyConnectionFailures <
              (options.ptyConnectionFailuresBeforeSuccess ?? 0)
            ) {
              ptyConnectionFailures += 1;
              await new Promise(() => {});
            }
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
        if (command.includes("cat /workspace/.makeademo/sandbox-log.jsonl")) {
          return {
            exitCode: 0,
            result: options.sandboxLogContents ?? "",
          };
        }
        if (options.executeCommandFails === true) {
          throw new Error("executeCommand failed");
        }
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
          options.awaitWorkspaceLogMirror !== undefined &&
          command.includes("/workspace/.makeademo/sandbox-log.jsonl")
        ) {
          options.onWorkspaceLogMirrorStarted?.();
          await options.awaitWorkspaceLogMirror;
        }
        if (
          options.failWorkspaceLogMirror === true &&
          command.includes("/workspace/.makeademo/sandbox-log.jsonl")
        ) {
          return {
            exitCode: 1,
            result: "",
            stderr:
              "mkdir: cannot create directory '/workspace': Permission denied",
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
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
