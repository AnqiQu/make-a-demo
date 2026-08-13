import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { AgentHarnessControlPlaneError } from "../../../agent-harness/daytona/workspace.interface";
import { createDaytonaControlPlaneEnvelope } from "./daytona-control-plane";
import {
  DaytonaSdkPreparationWorkspaceProvider,
  createDaytonaSdkPreparationWorkspaceHandle,
  destroyAllDaytonaWorkspaces,
} from "./daytona-sdk-preparation-workspace-provider";

const execFileAsync = promisify(execFile);

/** The real envelope with waits removed, so retry paths run at test speed. */
function instantControlPlane() {
  return createDaytonaControlPlaneEnvelope({
    logger: {
      error: async () => {},
      info: async () => {},
      warn: async () => {},
    },
    random: () => 0.5,
    wait: async () => {},
  });
}

describe("DaytonaSdkPreparationWorkspaceProvider", () => {
  it("creates a non-auto-stopping agent sandbox from the configured snapshot", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
      snapshot: "makeademo-opencode",
    });

    const handle = await provider.create();

    expect(handle.id).toBe("sandbox_123");
    expect(calls[0]).toEqual({
      create: {
        autoDeleteInterval: 150,
        autoStopInterval: 0,
        disk: 3,
        snapshot: "makeademo-opencode",
      },
    });
  });

  it("destroys still-live workspaces when the process shuts down", async () => {
    // Killed matrix runs leave their sandboxes running until the server-side
    // backstop reaps them hours later (18 orphans, 2026-08-08). Every created
    // handle registers with the process-wide registry so a shutdown hook can
    // delete whatever a dead run left behind; a handle destroyed normally
    // must not be deleted twice.
    await destroyAllDaytonaWorkspaces();
    const calls: unknown[] = [];
    const sandboxA = fakeLinkedSandbox(calls, "sandbox_a", "ok");
    const sandboxB = fakeLinkedSandbox(calls, "sandbox_b", "ok");
    let created = 0;
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create() {
          created += 1;
          return created === 1 ? sandboxA : sandboxB;
        },
        async delete(input: { id?: string; name?: string }) {
          calls.push({ delete: input.id ?? input.name });
        },
      } as never,
    });
    const first = await provider.create();
    await provider.create();
    await first.destroy();

    await destroyAllDaytonaWorkspaces();

    expect(calls.filter((call) => "delete" in Object(call))).toEqual([
      { delete: "sandbox_a" },
      { delete: "sandbox_b" },
    ]);
  });

  it("keeps the original failure when the compensating parent delete also fails", async () => {
    const calls: unknown[] = [];
    const parentSandbox = fakeLinkedSandbox(calls, "parent_sandbox", "ok");
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create(input: unknown) {
          calls.push({ create: input });
          if (
            typeof input === "object" &&
            input !== null &&
            "linkedSandbox" in input
          ) {
            throw new Error("submitted-code snapshot unavailable");
          }
          return parentSandbox;
        },
        async delete(input: { id?: string; name?: string }) {
          calls.push({ delete: input.id ?? input.name });
          throw new Error("delete rejected while sandbox state changes");
        },
      } as never,
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });

    await expect(provider.create()).rejects.toThrow(
      "submitted-code snapshot unavailable",
    );
    expect(calls.filter((call) => "delete" in Object(call))).toHaveLength(1);
  });

  it("treats a sandbox-state conflict during deletion as a retryable outcome", async () => {
    const calls: unknown[] = [];
    let deletes = 0;
    const parentSandbox = fakeLinkedSandbox(calls, "sandbox_123", "ok");
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create(input: unknown) {
          calls.push({ create: input });
          return parentSandbox;
        },
        async delete(input: { id?: string; name?: string }) {
          deletes += 1;
          calls.push({ delete: input.id ?? input.name });
          if (deletes === 1) {
            throw Object.assign(new Error("sandbox state change in progress"), {
              statusCode: 409,
            });
          }
        },
      } as never,
      controlPlane: instantControlPlane(),
    });
    const handle = await provider.create();

    await handle.destroy();

    expect(deletes).toBe(2);
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
      create: { autoDeleteInterval: 150, autoStopInterval: 0, disk: 3 },
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
      controlPlane: instantControlPlane(),
      sandboxCreateTimeoutSeconds: 180,
    });

    const handle = await provider.create();

    expect(handle.id).toBe("sandbox_123");
    expect(calls.slice(0, 2)).toEqual([
      {
        create: { autoDeleteInterval: 150, autoStopInterval: 0, disk: 3 },
        options: { timeout: 180 },
      },
      {
        create: { autoDeleteInterval: 150, autoStopInterval: 0, disk: 3 },
        options: { timeout: 180 },
      },
    ]);
  });

  it("retries sandbox creation past a transient 502 window", async () => {
    // Outline (2026-08-09): one 502 at an unretried create seam ended the
    // whole run inside the parallel launch window.
    const calls: unknown[] = [];
    const sandbox = fakeLinkedSandbox(calls, "sandbox_123", "ok");
    let creates = 0;
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create(input: unknown) {
          calls.push({ create: input });
          creates += 1;
          if (creates === 1) {
            throw Object.assign(
              new Error("Request failed with status code 502"),
              { statusCode: 502 },
            );
          }
          return sandbox;
        },
        async delete() {},
      } as never,
      controlPlane: instantControlPlane(),
    });

    const handle = await provider.create();

    expect(handle.id).toBe("sandbox_123");
    expect(creates).toBe(2);
  });

  it("waits out the in-progress conflict message during deletion", async () => {
    // The message shape midday actually died on (2026-08-09) — carried by
    // a plain 409 body, not the older "state change in progress" wording.
    const calls: unknown[] = [];
    let deletes = 0;
    const parentSandbox = fakeLinkedSandbox(calls, "sandbox_123", "ok");
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create(input: unknown) {
          calls.push({ create: input });
          return parentSandbox;
        },
        async delete() {
          deletes += 1;
          if (deletes < 3) {
            throw Object.assign(
              new Error(
                "An operation is already in progress for this resource",
              ),
              { statusCode: 409 },
            );
          }
        },
      } as never,
      controlPlane: instantControlPlane(),
    });
    const handle = await provider.create();

    await handle.destroy();

    expect(deletes).toBe(3);
  });

  it("retries the submitted-code network toggle through a conflict and succeeds", async () => {
    // Midday (2026-08-09): the network toggle's first 409 killed the run
    // and surfaced to the maker as a repair prompt. The toggle is
    // re-issuable: wait for the in-progress operation, then re-issue.
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        networkError: Object.assign(
          new Error("An operation is already in progress for this resource"),
          { statusCode: 409 },
        ),
        networkFailuresBeforeSuccess: 2,
      }),
      controlPlane: instantControlPlane(),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await handle.workspace.setSubmittedCodeNetworkAccess(true);

    expect(
      calls.filter((call) => "updateNetworkSettings" in Object(call)),
    ).toHaveLength(3);
  });

  it("surfaces an exhausted control-plane retry as a typed infrastructure failure", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        networkError: Object.assign(
          new Error("An operation is already in progress for this resource"),
          { statusCode: 409 },
        ),
      }),
      controlPlane: instantControlPlane(),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    const thrown: unknown = await handle.workspace
      .setSubmittedCodeNetworkAccess(true)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AgentHarnessControlPlaneError);
    expect(thrown).toMatchObject({ operation: "sandbox.network-update" });
  });

  it("routes control-plane attribution through a caller-provided pipeline logger", async () => {
    // The pipeline hands the provider its own structured logger (the
    // mini-matrix ran with every daytona.* event dark because only sinks
    // were wireable, 2026-08-10); events must land there attributed.
    const entries: Array<Record<string, unknown>> = [];
    const calls: unknown[] = [];
    const sandbox = fakeLinkedSandbox(calls, "sandbox_123", "ok");
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create(input: unknown) {
          calls.push({ create: input });
          return sandbox;
        },
        async delete() {},
      } as never,
      controlPlaneLogger: {
        error: async (entry) => void entries.push(entry),
        info: async (entry) => void entries.push(entry),
        warn: async (entry) => void entries.push(entry),
      },
    });

    await provider.create();

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "daytona.agent-sandbox.create.attempt",
      }),
    );
  });

  it("attributes every control-plane attempt to its seam in the pipeline log", async () => {
    // A 27-minute silent gap must never again be unattributable: each
    // attempt names its operation and sandbox before the SDK call starts.
    const lines: string[] = [];
    const calls: unknown[] = [];
    const sandbox = fakeLinkedSandbox(calls, "sandbox_123", "ok");
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: {
        async create(input: unknown) {
          calls.push({ create: input });
          return sandbox;
        },
        async delete() {},
      } as never,
      sandboxLogSinks: [{ write: (line) => void lines.push(line) }],
    });

    await provider.create();

    expect(
      lines.some((line) =>
        line.includes('"event":"daytona.agent-sandbox.create.attempt"'),
      ),
    ).toBe(true);
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
        autoDeleteInterval: 150,
        autoStopInterval: 0,
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

  it("writes text artifacts atomically only to the agent sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await handle.workspace.writeTextFile(
      "/workspace/.makeademo/action-catalog.json",
      `${"x".repeat(150_000)}\n`,
    );

    const uploads = calls.filter((call) => "uploadFiles" in Object(call));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      uploadFiles: {
        sandbox: "parent_sandbox",
      },
    });
    expect(
      calls.some(
        (call) =>
          "executeCommand" in Object(call) &&
          JSON.stringify(call).includes("mv -f") &&
          JSON.stringify(call).includes("parent_sandbox"),
      ),
    ).toBe(true);
    expect(
      calls.some((call) => JSON.stringify(call).includes("submitted_sandbox")),
    ).toBe(false);
  });

  it("reports filesystem transfer failures with destination and payload size", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        uploadError: new Error("filesystem upload rejected"),
      }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.writeTextFile(
        "/workspace/.makeademo/action-catalog.json",
        "large catalog",
      ),
    ).rejects.toThrow(
      "Daytona agent artifact filesystem transfer failed for /workspace/.makeademo/action-catalog.json (13 bytes): filesystem upload rejected",
    );
    expect(calls.filter((call) => "uploadFiles" in Object(call))).toHaveLength(
      1,
    );
  });

  it("retries a transient 502 while writing a text artifact", async () => {
    // homer and twenty each lost a whole matrix run to one transient 502
    // during an artifact upload (2026-08-09); a single retry absorbs the blip.
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      artifactTransferBackoffMs: [1, 1],
      client: fakeClient(calls, {
        uploadError: Object.assign(
          new Error("Request failed with status code 502"),
          { statusCode: 502 },
        ),
        uploadFailuresBeforeSuccess: 1,
      }),
    });
    const handle = await provider.create();

    await handle.workspace.writeTextFile(
      "/workspace/.makeademo/repo-profile.json",
      "{}",
    );

    const uploads = calls.filter(
      (call) => "uploadFiles" in Object(call),
    ) as Array<{ uploadFiles: Array<{ destination: string }> }>;
    expect(uploads).toHaveLength(2);
    expect(uploads[0]?.uploadFiles[0]?.destination).not.toBe(
      uploads[1]?.uploadFiles[0]?.destination,
    );
    expect(
      calls.filter(
        (call) =>
          "executeCommand" in Object(call) &&
          String((call as { executeCommand: string }).executeCommand).includes(
            "mv -f",
          ),
      ),
    ).toHaveLength(1);
  });

  it("fails a persistent 502 text artifact transfer after bounded retries", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      artifactTransferBackoffMs: [1, 1],
      client: fakeClient(calls, {
        uploadError: Object.assign(
          new Error("Request failed with status code 502"),
          { statusCode: 502 },
        ),
      }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.writeTextFile(
        "/workspace/.makeademo/repo-profile.json",
        "{}",
      ),
    ).rejects.toThrow(
      "Daytona agent artifact filesystem transfer failed for /workspace/.makeademo/repo-profile.json (2 bytes): Request failed with status code 502",
    );
    expect(calls.filter((call) => "uploadFiles" in Object(call))).toHaveLength(
      3,
    );
  });

  it("survives a sustained control-plane 502 window with the default transfer ladder", async () => {
    // A real Daytona incident (directus, 2026-08-12T20:40) 502-stormed the
    // API for minutes, not one blip; the run died mid-window because the
    // default transfer ladder covered ~5s. The default ladder must span a
    // control-plane-scale outage before declaring a transfer dead.
    const waits: number[] = [];
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        uploadError: Object.assign(
          new Error("Request failed with status code 502"),
          { statusCode: 502 },
        ),
        uploadFailuresBeforeSuccess: 5,
      }),
      controlPlane: createDaytonaControlPlaneEnvelope({
        logger: {
          error: async () => {},
          info: async () => {},
          warn: async () => {},
        },
        random: () => 0.5,
        wait: async (delayMs) => {
          waits.push(delayMs);
        },
      }),
    });
    const handle = await provider.create();

    await handle.workspace.writeTextFile(
      "/workspace/.makeademo/runtime-target-selection-contract.json",
      "{}",
    );

    expect(calls.filter((call) => "uploadFiles" in Object(call))).toHaveLength(
      6,
    );
    const coveredWindowMs = waits.reduce(
      (total, delayMs) => total + delayMs,
      0,
    );
    expect(coveredWindowMs).toBeGreaterThanOrEqual(60_000);
  });

  it("retries a transient 502 while uploading screened workspace files", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      artifactTransferBackoffMs: [1, 1],
      client: fakeClient(calls, {
        uploadError: Object.assign(
          new Error("Request failed with status code 502"),
          { statusCode: 502 },
        ),
        uploadFailuresBeforeSuccess: 1,
      }),
    });
    const handle = await provider.create();

    await handle.workspace.uploadFiles([
      {
        destinationPath: "/workspace/package.json",
        sourcePath: "/tmp/repo/package.json",
      },
    ]);

    expect(calls.filter((call) => "uploadFiles" in Object(call))).toHaveLength(
      2,
    );
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

  it("executes commands and deletes the sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("opencode run hello");
    await handle.destroy();

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ok" });
    expect(calls.slice(1)).toEqual([
      { executeCommand: "opencode run hello" },
      { delete: "sandbox_123" },
    ]);
  });

  it("treats a missing Daytona exit code as a failed command", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { executeCommandOmitsExitCode: true }),
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("opencode run hello");

    expect(result.exitCode).toBe(1);
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

  it("retries an agent-sandbox command past a transient control-plane 502", async () => {
    // ghostfolio 2026-08-13T01-12: the first harness step after an
    // 11-minute prep agent succeeded was `cat`-ing the manifest, and one
    // raw 502 killed the run. Agent-sandbox commands are harness-authored
    // idempotent bookkeeping, so they ride the transient ladder (N123).
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { executeCommand502FailuresBeforeSuccess: 1 }),
      controlPlane: instantControlPlane(),
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute(
      "cat /workspace/.makeademo/preparation-manifest.json",
    );

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ok" });
    expect(
      calls.filter((call) => "executeCommand" in Object(call)),
    ).toHaveLength(2);
  });

  it("wraps a persistent command 502 window as a typed infrastructure failure", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        executeCommand502FailuresBeforeSuccess: 99,
      }),
      controlPlane: instantControlPlane(),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("git status --porcelain"),
    ).rejects.toBeInstanceOf(AgentHarnessControlPlaneError);
  });

  it("never re-issues a command whose deadline elapsed", async () => {
    // A command deadline is the command's outcome — the harness converts it
    // into bounded feedback; blindly re-running a possibly-completed
    // command could double its side effects.
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { executeCommandNeverResolves: true }),
      commandTimeoutMs: 1,
      controlPlane: instantControlPlane(),
    });
    const handle = await provider.create();

    await expect(handle.workspace.execute("npm ci")).rejects.toThrow(
      "Daytona command did not finish within 1ms.",
    );
    expect(
      calls.filter((call) => "executeCommand" in Object(call)),
    ).toHaveLength(1);
  });

  it("classifies a transient failure on an at-most-once command without re-issuing it", async () => {
    // The restore path's `git apply` may already have taken effect when a
    // 502 masks its success; retry: "none" keeps at-most-once semantics
    // while still classifying the loss as infrastructure.
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { executeCommand502FailuresBeforeSuccess: 1 }),
      controlPlane: instantControlPlane(),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("git apply --binary /tmp/restore.patch", {
        retry: "none",
      }),
    ).rejects.toBeInstanceOf(AgentHarnessControlPlaneError);
    expect(
      calls.filter((call) => "executeCommand" in Object(call)),
    ).toHaveLength(1);
  });

  it("does not re-issue a submitted-code command on a transient failure by default", async () => {
    // Submitted-code commands can drive the app under test (exploration
    // crawls, capture scripts); a 502 can mask a command that already ran,
    // so the default is classify-only — never a blind re-issue.
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        submittedExecute502: { commandIncludes: "capture.mjs", failures: 1 },
      }),
      controlPlane: instantControlPlane(),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.executeSubmittedCode("bun /tmp/capture.mjs"),
    ).rejects.toBeInstanceOf(AgentHarnessControlPlaneError);
    expect(
      calls.filter((call) => {
        const command = Object(call).executeCommand as
          | { command?: string; sandbox?: string }
          | string
          | undefined;
        return (
          typeof command === "object" &&
          command?.command?.includes("capture.mjs") === true
        );
      }),
    ).toHaveLength(1);
  });

  it("retries a submitted-code command that opted into transient retry", async () => {
    // Provably idempotent submitted-code reads (cat exploration output,
    // readiness curls) declare retry: "transient" explicitly.
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        submittedExecute502: {
          commandIncludes: "exploration.json",
          failures: 1,
        },
      }),
      controlPlane: instantControlPlane(),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    const result = await handle.workspace.executeSubmittedCode(
      "cat /workspace/.makeademo/exploration/exploration.json",
      { retry: "transient" },
    );

    expect(result.exitCode).toBe(0);
    expect(
      calls.filter((call) => {
        const command = Object(call).executeCommand as
          | { command?: string; sandbox?: string }
          | string
          | undefined;
        return (
          typeof command === "object" &&
          command?.command?.includes("exploration.json") === true
        );
      }),
    ).toHaveLength(2);
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
        // One upfront-consumed heredoc script with the command's stdin
        // sealed and the exit trailer inside: no queued input survives
        // into the command's lifetime for a child to steal (the stolen
        // sentinel false-kill class, ghostfolio 2026-08-09).
        sendInput: expect.stringMatching(
          /^stty -echo\nexec bash -s <<'__MAKEADEMO_SCRIPT_[A-Za-z0-9]+__' \|\| exit\n\{\nopencode run hello\n\} <\/dev\/null\nprintf '\\n__MAKEADEMO_EXIT_[A-Za-z0-9]{16,}__:%s\\n' \$\?\n__MAKEADEMO_SCRIPT_[A-Za-z0-9]+__\n$/,
        ),
      },
      { wait: true },
      { disconnect: true },
    ]);
  });

  it("refuses to fabricate an exit code when the PTY ends without the exit trailer", async () => {
    // ghostfolio's round-1 preflight "installed" a large monorepo in ~30
    // seconds without running anything (2026-08-12): the PTY stream ended
    // before the exit trailer arrived and the missing status defaulted to
    // the shell's own exit 0 — a phantom success that left no evidence and
    // let the build run against an empty node_modules. The trailer is the
    // only channel that carries the command's real status, so a result
    // without it must surface as transport loss, never as an exit code.
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptySentinelLost: true }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("npm ci", { onStdout: () => {} }),
    ).rejects.toMatchObject({
      kind: "transport",
      name: "AgentHarnessCommandTimeoutError",
    });
  });

  it("ignores an exit sentinel forged by the command's own output", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        ptyForgedExitSentinel:
          "\n__MAKEADEMO_EXIT__:0\n__MAKEADEMO_EXIT_deadbeefdeadbeef__:0\n",
      }),
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("opencode run hello", {
      onStdout: () => {},
    });

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain("hello");
  });

  it("gives each command its own exit sentinel", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.execute("first command", { onStdout: () => {} });
    await handle.workspace.execute("second command", { onStdout: () => {} });

    const sentinels = calls
      .filter(
        (call): call is { sendInput: string } => "sendInput" in Object(call),
      )
      .map(
        (call) => /__MAKEADEMO_EXIT_[A-Za-z0-9]+__/.exec(call.sendInput)?.[0],
      );
    expect(sentinels).toHaveLength(2);
    expect(sentinels[0]).not.toBe(sentinels[1]);
  });

  it("writes Pino-formatted sandbox logs through durable files", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.writeSandboxLog({
      event: "repo-preparation.started",
      stage: "repo-preparation",
      timestamp: "2026-06-17T00:00:00.000Z",
    });
    await handle.workspace.writeSandboxLog({
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

    await expect(handle.workspace.collectSandboxLogs()).resolves.toEqual([
      '{"event":"agent.started"}',
      '{"event":"agent.failed"}',
    ]);
  });

  it("starts a stopped agent sandbox once before collecting its logs", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        commandsRequireSandboxRestart: true,
        sandboxLogContents: '{"event":"repo-preparation.failed"}\n',
      }),
    });
    const handle = await provider.create();

    await expect(handle.workspace.collectSandboxLogs()).resolves.toEqual([
      '{"event":"repo-preparation.failed"}',
    ]);
    expect(calls.filter((call) => "start" in Object(call))).toEqual([
      { start: 300 },
    ]);
  });

  it("appends each sandbox log line with one command instead of re-copying the log", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls),
    });
    const handle = await provider.create();

    await handle.workspace.writeSandboxLog({
      event: "repo-preparation.started",
      stage: "repo-preparation",
    });

    const logCommands = calls
      .filter(
        (call): call is { executeCommand: string } =>
          typeof call === "object" &&
          call !== null &&
          "executeCommand" in call &&
          typeof call.executeCommand === "string" &&
          call.executeCommand.includes("sandbox-log.jsonl"),
      )
      .map((call) => call.executeCommand);
    expect(logCommands).toHaveLength(1);
    expect(logCommands[0]).toContain(">> '/tmp/makeademo/sandbox-log.jsonl'");
  });

  it("fails fast when a durable sandbox log write does not finish", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { executeCommandNeverResolves: true }),
      logWriteTimeoutMs: 1,
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.writeSandboxLog({
        event: "project-validation.started",
        stage: "project-validation",
      }),
    ).rejects.toThrow("Daytona sandbox log write did not finish within 1ms.");
  });

  it("retries a durable sandbox log write past a transient 502", async () => {
    // A duplicated audit line is acceptable; a run killed by one 502 while
    // appending its own audit trail is not (N123).
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        sandboxLogWrite502FailuresBeforeSuccess: 1,
      }),
      controlPlane: instantControlPlane(),
    });
    const handle = await provider.create();

    await handle.workspace.writeSandboxLog({
      event: "repo-preparation.started",
      stage: "repo-preparation",
    });

    expect(
      calls.filter((call) => {
        const command = Object(call).executeCommand;
        return (
          typeof command === "string" &&
          command.includes(">> '/tmp/makeademo/sandbox-log.jsonl'")
        );
      }),
    ).toHaveLength(2);
  });

  it("retries sandbox log collection past a transient 502", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        sandboxLogCollect502FailuresBeforeSuccess: 1,
        sandboxLogContents: '{"event":"repo-preparation.failed"}',
      }),
      controlPlane: instantControlPlane(),
    });
    const handle = await provider.create();

    await expect(handle.workspace.collectSandboxLogs()).resolves.toEqual([
      '{"event":"repo-preparation.failed"}',
    ]);
    expect(
      calls.filter((call) => {
        const command = Object(call).executeCommand;
        return typeof command === "string" && command.includes("tail -c");
      }),
    ).toHaveLength(2);
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
    await waitForCall(calls, "sendInput");
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
    expect(calls).toContainEqual({ kill: true });
    expect(calls).toContainEqual({ disconnect: true });
  });

  it("re-arms a late-firing inactivity deadline instead of killing the command", async () => {
    // A deadline firing far past its window measured silence the sleeping host
    // never observed (2026-08-03 incident: lid-closed laptop, healthy sandbox
    // agents killed on DarkWakes). The drifted firing must log and re-arm; only
    // an on-time expiry may kill.
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    try {
      const calls: unknown[] = [];
      const provider = new DaytonaSdkPreparationWorkspaceProvider({
        client: fakeClient(calls, { ptyWaitsForDisconnect: true }),
        commandTimeoutMs: 10_000,
      });
      const handle = await provider.create();

      const execution = handle.workspace.execute("opencode run stalled", {
        inactivityTimeoutMs: 200,
        onStdout: () => {},
      });
      let settled = false;
      execution.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      vi.setSystemTime(40 * 60_000);
      // Land between the drifted firing (~200ms) and the re-armed one (~400ms).
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(settled).toBe(false);
      const driftLogs = calls
        .map((call) => (call as { executeCommand?: string }).executeCommand)
        .filter((command) => command?.includes("host.clock.drift"));
      expect(driftLogs).toHaveLength(1);

      await expect(execution).rejects.toThrow(
        "Daytona command produced no output for 200ms.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("disconnects a streaming command that stops producing output", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyWaitsForDisconnect: true }),
      commandTimeoutMs: 10_000,
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("opencode run stalled", {
        inactivityTimeoutMs: 1,
        onStdout: () => {},
      }),
    ).rejects.toThrow("Daytona command produced no output for 1ms.");
    expect(calls).toContainEqual({ disconnect: true });
  });

  it("preserves a command timeout when PTY disconnection stalls", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        ptyDisconnectNeverResolves: true,
        ptyWaitsForDisconnect: true,
      }),
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

  it("starts a stopped agent sandbox once before retrying PTY startup", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, { ptyRequiresSandboxRestart: true }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("opencode run hello", { onStdout: () => {} }),
    ).resolves.toMatchObject({ exitCode: 7 });
    expect(calls.filter((call) => "start" in Object(call))).toEqual([
      { start: 300 },
    ]);
  });

  it("reports a typed sandbox failure when a bounded restart does not recover PTY access", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeClient(calls, {
        ptyRequiresSandboxRestart: true,
        sandboxRestartDoesNotRecover: true,
      }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.execute("opencode run hello", { onStdout: () => {} }),
    ).rejects.toMatchObject({
      name: "AgentHarnessSandboxUnavailableError",
      sandboxId: "sandbox_123",
    });
    expect(calls.filter((call) => "start" in Object(call))).toHaveLength(1);
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

    await handle.workspace.writeSandboxLog({
      event: "project-validation.dependency-install.started",
      stage: "project-validation",
      workspaceId: "workspace_123",
    });

    // The same sinks also carry daytona-control-plane attribution events;
    // this test pins the sandbox-audit relay specifically.
    const sandboxAuditLogs = relayedLogs.filter((line) =>
      line.includes('"component":"daytona-sandbox"'),
    );
    expect(sandboxAuditLogs).toHaveLength(1);
    expect(JSON.parse(sandboxAuditLogs[0] ?? "{}")).toMatchObject({
      component: "daytona-sandbox",
      event: "project-validation.dependency-install.started",
      message: "project-validation.dependency-install.started",
      stage: "project-validation",
      workspaceId: "workspace_123",
    });
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
          autoDeleteInterval: 150,
          autoStopInterval: 0,
          disk: 3,
          snapshot: "makeademo-opencode",
        },
      },
      {
        create: {
          autoStopInterval: 0,
          autoDeleteInterval: 0,
          disk: 10,
          ephemeral: true,
          linkedSandbox: "parent_sandbox",
          networkBlockAll: true,
          snapshot: "makeademo-submitted-code-browser",
        },
      },
    ]);
  });

  it("continues when org policy rejects submitted-code network overrides", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        networkError: new Error(
          "Network access is restricted and cannot be overridden at the sandbox level.",
        ),
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.setSubmittedCodeNetworkAccess(true),
    ).resolves.toBeUndefined();
    await expect(
      handle.workspace.setSubmittedCodeNetworkAccess(false),
    ).resolves.toBeUndefined();

    expect(
      calls.filter(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "updateNetworkSettings" in call,
      ),
    ).toHaveLength(2);
  });

  it("does not swallow a reseal failure when the install window actually opened", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        networkCloseError: new Error(
          "Network access is restricted and cannot be overridden at the sandbox level.",
        ),
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.setSubmittedCodeNetworkAccess(true),
    ).resolves.toBeUndefined();
    await expect(
      handle.workspace.setSubmittedCodeNetworkAccess(false),
    ).rejects.toThrow(/cannot be overridden/);

    const transitions = await handle.workspace.collectNetworkStateLog();
    expect(transitions?.map((transition) => transition.state)).toEqual([
      "runtime-locked",
      "dependency-install-open",
    ]);
  });

  it("uploads submitted-code artifacts only to the submitted-code sandbox", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await handle.workspace.uploadSubmittedCodeFiles([
      {
        destinationPath: "/workspace/.makeademo/capture/demo-script.ts",
        sourcePath: "/tmp/demo-script.ts",
      },
    ]);

    expect(
      calls.filter(
        (call) =>
          typeof call === "object" && call !== null && "uploadFiles" in call,
      ),
    ).toEqual([
      {
        uploadFiles: {
          files: [
            {
              destination: "/workspace/.makeademo/capture/demo-script.ts",
              source: "/tmp/demo-script.ts",
            },
          ],
          sandbox: "submitted_sandbox",
          timeoutSec: 60,
        },
      },
    ]);
  });

  it("keeps shared artifact transfer logs independent of pipeline stages", async () => {
    const calls: unknown[] = [];
    const relayedLogs: string[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls),
      sandboxLogSinks: [
        {
          write(line) {
            relayedLogs.push(line);
          },
        },
      ],
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await handle.workspace.uploadSubmittedCodeFiles([
      {
        destinationPath: "/workspace/.makeademo/capture/demo-script.ts",
        sourcePath: "/tmp/demo-script.ts",
      },
    ]);

    const transferLogs = relayedLogs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((log) =>
        String(log.event).startsWith("artifact.transfer.upload."),
      );
    expect(transferLogs.map((log) => log.event)).toEqual([
      "artifact.transfer.upload.started",
      "artifact.transfer.upload.succeeded",
    ]);
    for (const log of transferLogs) {
      expect(log).not.toHaveProperty("stage");
    }
  });

  it("retries a transient submitted-code artifact upload", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      artifactTransferBackoffMs: [1, 1],
      client: fakeLinkedClient(calls, {
        submittedUploadFailuresBeforeSuccess: 1,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.uploadSubmittedCodeFiles([
        {
          destinationPath: "/workspace/.makeademo/capture/demo-script.ts",
          sourcePath: "/tmp/demo-script.ts",
        },
      ]),
    ).resolves.toBeUndefined();

    expect(
      calls.filter(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "uploadFiles" in call &&
          (call as { uploadFiles: { sandbox: string } }).uploadFiles.sandbox ===
            "submitted_sandbox",
      ),
    ).toHaveLength(2);
  });

  it("retries the prepared-workspace sync after a transient submitted-code failure", async () => {
    // Cyberchef died 71 minutes in when one control-plane socket dropped
    // during a workspace reset (2026-08-09): the sync is idempotent, so a
    // transport blip costs a bounded retry, never the run.
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      artifactTransferBackoffMs: [1, 1],
      client: fakeLinkedClient(calls, {
        submittedUploadFailuresBeforeSuccess: 1,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.syncSubmittedCodeWorkspace(),
    ).resolves.toBeUndefined();

    const submittedUploads = calls.filter(
      (call) =>
        typeof call === "object" &&
        call !== null &&
        "uploadFiles" in call &&
        (call as { uploadFiles: { sandbox: string } }).uploadFiles.sandbox ===
          "submitted_sandbox",
    );
    expect(submittedUploads).toHaveLength(2);
  });

  it("treats an abruptly closed control-plane socket as a transient transfer failure", async () => {
    // Bun's fetch reports a dropped Daytona API connection as "The socket
    // connection was closed unexpectedly" — same transport blip as a 502,
    // same bounded retry.
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      artifactTransferBackoffMs: [1, 1],
      client: fakeClient(calls, {
        uploadError: new Error(
          "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        ),
        uploadFailuresBeforeSuccess: 1,
      }),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.writeTextFile(
        "/workspace/.makeademo/repo-profile.json",
        "{}",
      ),
    ).resolves.toBeUndefined();

    expect(calls.filter((call) => "uploadFiles" in Object(call))).toHaveLength(
      2,
    );
  });

  it("reports a typed submitted-code artifact failure after bounded retries", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      artifactTransferBackoffMs: [1, 1],
      client: fakeLinkedClient(calls, {
        submittedUploadFailuresBeforeSuccess: 99,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.uploadSubmittedCodeFiles([
        {
          destinationPath: "/workspace/.makeademo/capture/demo-script.ts",
          sourcePath: "/tmp/demo-script.ts",
        },
      ]),
    ).rejects.toMatchObject({
      attempts: 3,
      message: expect.stringContaining(
        "DaytonaTimeoutError: Operation timed out",
      ),
      name: "AgentHarnessArtifactTransferError",
      operation: "upload",
      sandboxId: "submitted_sandbox",
    });
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
          autoDeleteInterval: 150,
          autoStopInterval: 0,
          disk: 3,
          secrets: { OPENAI_API_KEY: "makeademo-openai" },
        },
      },
      {
        create: {
          autoStopInterval: 0,
          autoDeleteInterval: 0,
          disk: 10,
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

    await handle.workspace.uploadFiles([
      {
        destinationPath: "/workspace/package.json",
        sourcePath: "/tmp/repo/package.json",
      },
    ]);
    const result = await handle.workspace.executeSubmittedCode("npm test");
    await handle.workspace.setSubmittedCodeNetworkAccess(true);
    const networkTransitions = await handle.workspace.collectNetworkStateLog();

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
          executeCommand: { command: "npm test", sandbox: "submitted_sandbox" },
        },
        {
          updateNetworkSettings: {
            sandbox: "submitted_sandbox",
            settings: { networkBlockAll: false },
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

    await handle.workspace.startSubmittedCodeApp({
      command: "npm run dev -- --host 0.0.0.0",
      cwd: "/workspace/repo with spaces",
      env: { DEMO_MODE: "customer's demo" },
    });
    const status = await handle.workspace.readSubmittedCodeAppStatus();
    await handle.workspace.stopSubmittedCodeApp();

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
              "mkdir -p '/workspace/.makeademo/runtime-tmp' && cd '/workspace/repo with spaces' && env 'DEMO_MODE=customer'\\''s demo' 'TMPDIR=/workspace/.makeademo/runtime-tmp' sh -lc 'npm run dev -- --host 0.0.0.0'",
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
    expect(status).toMatchObject({
      endedAt: expect.any(String),
      exitCode: 0,
      running: false,
      startedAt: expect.any(String),
      stderr: "",
      stdout: "",
      terminationReason: "exited",
    });
  });

  it("classifies a transient failure launching the managed app without re-issuing it", async () => {
    // A 502 can mask a launch that already started the app; re-issuing
    // would run two app processes, so the launch is at most once and its
    // transport loss surfaces classified (N123).
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        sessionLaunch502FailuresBeforeSuccess: 1,
      }),
      controlPlane: instantControlPlane(),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.startSubmittedCodeApp({
        command: "npm run dev",
        cwd: "/workspace/repo",
      }),
    ).rejects.toBeInstanceOf(AgentHarnessControlPlaneError);
    expect(
      calls.filter((call) => "executeSessionCommand" in Object(call)),
    ).toHaveLength(1);
  });

  it("retries a managed-app status read past a transient 502", async () => {
    // Status polls are pure reads issued continuously by the readiness
    // loop; one 502 mid-incident must not end the round.
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        sessionStatus502FailuresBeforeSuccess: 1,
      }),
      controlPlane: instantControlPlane(),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await handle.workspace.startSubmittedCodeApp({
      command: "npm run dev",
      cwd: "/workspace/repo",
    });
    const status = await handle.workspace.readSubmittedCodeAppStatus();

    expect(status.running).toBe(false);
    expect(
      calls.filter((call) => "getSessionCommand" in Object(call)),
    ).toHaveLength(2);
  });

  it("passes the configured command timeout to submitted-code Daytona commands", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeCommandTimeoutClient(calls),
      commandTimeoutMs: 1_500,
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await handle.workspace.executeSubmittedCode("npm test", {
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
      handle.workspace.executeSubmittedCode("npm ci"),
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

    await handle.workspace.syncSubmittedCodeWorkspace();

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
    expect(restoreCommand).not.toContain(".vite");
    expect(restoreCommand).not.toContain(".turbo");
    expect(restoreCommand).toEqual(expect.stringContaining(".npm"));
    expect(restoreCommand).toEqual(expect.stringContaining(".pnpm-store"));
    expect(restoreCommand).toEqual(expect.stringContaining(".yarn/cache"));
    expect(restoreCommand).not.toContain(".next/cache");
    expect(restoreCommand).toEqual(expect.stringContaining(".bun"));
    expect(restoreCommand).not.toContain("-name .cache");
    expect(restoreCommand).not.toContain("cp -a");
    expect(restoreCommand).toEqual(
      expect.stringContaining("preserved_paths=$(mktemp)"),
    );
    expect(restoreCommand).toEqual(
      expect.stringContaining(
        "preserved=$(mktemp -d /workspace/.makeademo-reset.XXXXXX)",
      ),
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
    expect(restoreCommand).toEqual(
      expect.stringContaining('mv -- "$preserved/$relative" "$path" || exit 1'),
    );
    expect(restoreCommand).toEqual(expect.stringContaining(" || exit 1"));
    expect(restoreCommand).not.toContain("| while");
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

    await handle.workspace.syncSubmittedCodeWorkspace();

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

  it("restores submitted-code workspace while preserving dependencies but removing mutable runtime caches", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-daytona-shell-"));
    const parentWorkspace = join(root, "parent");
    const submittedWorkspace = join(root, "submitted");
    const calls: unknown[] = [];
    await mkdir(join(parentWorkspace, ".makeademo"), { recursive: true });
    await mkdir(join(parentWorkspace, "node_modules"), { recursive: true });
    await mkdir(join(submittedWorkspace, "node_modules"), { recursive: true });
    await mkdir(join(submittedWorkspace, ".next", "cache"), {
      recursive: true,
    });
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
    const preservedInode = (
      await stat(
        join(submittedWorkspace, "node_modules", "preserved-cache.txt"),
      )
    ).ino;
    await writeFile(join(submittedWorkspace, "stale.txt"), "remove me");
    await writeFile(
      join(submittedWorkspace, ".next", "cache", "stale-state"),
      "remove me",
    );
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLocalShellLinkedClient(calls, {
        parentWorkspace,
        submittedWorkspace,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });

    try {
      const handle = await provider.create();

      await handle.workspace.syncSubmittedCodeWorkspace();

      await expect(
        readFile(join(submittedWorkspace, "package.json"), "utf8"),
      ).resolves.toBe("prepared app");
      await expect(
        readFile(
          join(submittedWorkspace, "node_modules", "preserved-cache.txt"),
          "utf8",
        ),
      ).resolves.toBe("keep me");
      expect(
        (
          await stat(
            join(submittedWorkspace, "node_modules", "preserved-cache.txt"),
          )
        ).ino,
      ).toBe(preservedInode);
      await expectPathMissing(
        join(submittedWorkspace, "node_modules", "prepared-cache.txt"),
      );
      await expectPathMissing(join(submittedWorkspace, ".makeademo"));
      await expectPathMissing(join(submittedWorkspace, ".next"));
      await expectPathMissing(join(submittedWorkspace, "stale.txt"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("promotes only an approved reconciled lockfile into the prepared workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "makeademo-lockfile-promotion-"));
    const parentWorkspace = join(root, "parent");
    const submittedWorkspace = join(root, "submitted");
    await mkdir(join(parentWorkspace, "repo", "apps", "web"), {
      recursive: true,
    });
    await mkdir(join(submittedWorkspace, "repo", "apps", "web"), {
      recursive: true,
    });
    await writeFile(
      join(submittedWorkspace, "repo", "apps", "web", "package-lock.json"),
      "reconciled lockfile",
    );
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLocalShellLinkedClient([], {
        parentWorkspace,
        submittedWorkspace,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });

    try {
      const handle = await provider.create();
      await handle.workspace.promoteSubmittedCodeFiles([
        "apps/web/package-lock.json",
      ]);

      await expect(
        readFile(
          join(parentWorkspace, "repo", "apps", "web", "package-lock.json"),
          "utf8",
        ),
      ).resolves.toBe("reconciled lockfile");
      await expect(
        handle.workspace.promoteSubmittedCodeFiles(["apps/web/package.json"]),
      ).rejects.toThrow("recognized lockfile");
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

    await expect(handle.workspace.syncSubmittedCodeWorkspace()).rejects.toThrow(
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

    await expect(handle.workspace.syncSubmittedCodeWorkspace()).rejects.toThrow(
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

    await expect(handle.workspace.syncSubmittedCodeWorkspace()).rejects.toThrow(
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

  it("treats an already deleted submitted sandbox as successful cleanup", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        missingSubmittedSandboxOnDelete: true,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await expect(handle.destroy()).resolves.toBeUndefined();
    expect(calls.slice(-2)).toEqual([
      { delete: "submitted_sandbox" },
      { delete: "parent_sandbox" },
    ]);
  });

  it("retries only the Daytona sandbox deletions that previously failed", async () => {
    const calls: unknown[] = [];
    const provider = new DaytonaSdkPreparationWorkspaceProvider({
      client: fakeLinkedClient(calls, {
        submittedDeleteFailuresBeforeSuccess: 1,
      }),
      submittedCodeSnapshot: "makeademo-submitted-code-browser",
    });
    const handle = await provider.create();

    await expect(handle.destroy()).rejects.toThrow("transient delete failure");
    await expect(handle.destroy()).resolves.toBeUndefined();

    expect(calls.filter((call) => "delete" in Object(call))).toEqual([
      { delete: "submitted_sandbox" },
      { delete: "parent_sandbox" },
      { delete: "submitted_sandbox" },
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
    missingSubmittedSandboxOnDelete?: boolean;
    networkCloseError?: Error;
    networkError?: Error;
    remoteCleanupNeverResolves?: boolean;
    sessionLaunch502FailuresBeforeSuccess?: number;
    sessionStatus502FailuresBeforeSuccess?: number;
    submittedDeleteFailuresBeforeSuccess?: number;
    submittedExecute502?: { commandIncludes: string; failures: number };
    submittedUploadFailuresBeforeSuccess?: number;
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
  let submittedDeleteFailures = 0;

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
      const sandboxId = input.id ?? input.name;
      calls.push({ delete: sandboxId });
      if (
        sandboxId === "submitted_sandbox" &&
        submittedDeleteFailures <
          (options.submittedDeleteFailuresBeforeSuccess ?? 0)
      ) {
        submittedDeleteFailures += 1;
        throw new Error("transient delete failure");
      }
      if (
        options.missingSubmittedSandboxOnDelete === true &&
        sandboxId === "submitted_sandbox"
      ) {
        throw Object.assign(new Error("Sandbox not found"), {
          statusCode: 404,
        });
      }
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
          await copyFile(
            file.source.replace(/^\/workspace(?=\/|$)/, workspacePath),
            file.destination,
          );
        }
        return files.map((file) => ({ source: file.source }));
      },
      async uploadFiles(files: Array<{ destination: string; source: string }>) {
        calls.push({ uploadFiles: { files, sandbox: id } });
        for (const file of files) {
          const destination = file.destination.replace(
            /^\/workspace(?=\/|$)/,
            workspacePath,
          );
          await mkdir(dirname(destination), { recursive: true });
          await copyFile(file.source, destination);
        }
      },
    },
    id,
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
    networkCloseError?: Error;
    networkError?: Error;
    remoteCleanupNeverResolves?: boolean;
    sessionLaunch502FailuresBeforeSuccess?: number;
    sessionStatus502FailuresBeforeSuccess?: number;
    submittedExecute502?: { commandIncludes: string; failures: number };
    submittedUploadFailuresBeforeSuccess?: number;
  } = {},
) {
  let uploadAttempts = 0;
  let submittedExecute502Failures = 0;
  let sessionLaunch502Failures = 0;
  let sessionStatus502Failures = 0;
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
      async uploadFiles(files: unknown[], timeoutSec?: number) {
        uploadAttempts += 1;
        calls.push({
          uploadFiles: {
            files,
            sandbox: id,
            ...(timeoutSec === undefined ? {} : { timeoutSec }),
          },
        });
        if (
          id === "submitted_sandbox" &&
          uploadAttempts <= (options.submittedUploadFailuresBeforeSuccess ?? 0)
        ) {
          const error = new Error("Operation timed out");
          error.name = "DaytonaTimeoutError";
          throw error;
        }
      },
    },
    id,
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
        if (
          id === "submitted_sandbox" &&
          options.submittedExecute502 !== undefined &&
          command.includes(options.submittedExecute502.commandIncludes) &&
          submittedExecute502Failures < options.submittedExecute502.failures
        ) {
          submittedExecute502Failures += 1;
          throw Object.assign(
            new Error("Request failed with status code 502"),
            { statusCode: 502 },
          );
        }
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
        if (
          id === "submitted_sandbox" &&
          sessionLaunch502Failures <
            (options.sessionLaunch502FailuresBeforeSuccess ?? 0)
        ) {
          sessionLaunch502Failures += 1;
          throw Object.assign(
            new Error("Request failed with status code 502"),
            { statusCode: 502 },
          );
        }
        return { cmdId: "cmd_123" };
      },
      async getSessionCommand(sessionId: string, commandId: string) {
        calls.push({
          getSessionCommand: { commandId, sandbox: id, sessionId },
        });
        if (
          id === "submitted_sandbox" &&
          sessionStatus502Failures <
            (options.sessionStatus502FailuresBeforeSuccess ?? 0)
        ) {
          sessionStatus502Failures += 1;
          throw Object.assign(
            new Error("Request failed with status code 502"),
            { statusCode: 502 },
          );
        }
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
      if (options.networkError !== undefined) throw options.networkError;
      if (
        options.networkCloseError !== undefined &&
        (settings as { networkBlockAll?: boolean }).networkBlockAll === true
      ) {
        throw options.networkCloseError;
      }
    },
  };
}

function fakeClient(
  calls: unknown[],
  options: {
    commandsRequireSandboxRestart?: boolean;
    downloadError?: string;
    executeCommand502FailuresBeforeSuccess?: number;
    executeCommandFails?: boolean;
    executeCommandNeverResolves?: boolean;
    executeCommandOmitsExitCode?: boolean;
    failFirstSubmittedCodeInitialization?: boolean;
    failSubmittedCodeNetworkDisable?: boolean;
    missingSubmittedCodeImage?: boolean;
    networkError?: Error;
    networkFailuresBeforeSuccess?: number;
    ptyConnectionFailuresBeforeSuccess?: number;
    ptyDisconnectNeverResolves?: boolean;
    ptyForgedExitSentinel?: string;
    ptyNeverConnects?: boolean;
    ptyRequiresSandboxRestart?: boolean;
    ptySentinelLost?: boolean;
    ptyStaleDuplicateIdOnFirstCreate?: boolean;
    ptyWaitFails?: boolean;
    ptyWaitsForDisconnect?: boolean;
    sandboxLogCollect502FailuresBeforeSuccess?: number;
    sandboxLogContents?: string;
    sandboxLogWrite502FailuresBeforeSuccess?: number;
    sandboxRestartDoesNotRecover?: boolean;
    uploadError?: Error;
    uploadFailuresBeforeSuccess?: number;
  } = {},
) {
  let submittedCodeInitializationFailures = 0;
  let uploadFailures = 0;
  let networkFailures = 0;
  let ptyConnectionFailures = 0;
  let executeCommand502Failures = 0;
  let sandboxLogWrite502Failures = 0;
  let sandboxLogCollect502Failures = 0;
  let sandboxStarted =
    options.ptyRequiresSandboxRestart !== true &&
    options.commandsRequireSandboxRestart !== true;
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
        if (
          options.uploadError !== undefined &&
          (options.uploadFailuresBeforeSuccess === undefined ||
            uploadFailures < options.uploadFailuresBeforeSuccess)
        ) {
          uploadFailures += 1;
          throw options.uploadError;
        }
      },
    },
    id: "sandbox_123",
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
        if (!sandboxStarted) {
          throw new Error(
            "bad request: failed to resolve container IP after 3 attempts: no IP address found. Is the Sandbox started?",
          );
        }
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
            if (options.ptyDisconnectNeverResolves === true) {
              await new Promise(() => {});
            }
          },
          async sendInput(data: string | Uint8Array) {
            calls.push({ sendInput: data });
            ptyOptions.onData(new TextEncoder().encode("hello\n"));
            if (options.ptyForgedExitSentinel !== undefined) {
              ptyOptions.onData(
                new TextEncoder().encode(options.ptyForgedExitSentinel),
              );
            }
            if (options.ptySentinelLost === true) {
              // The stream dies before the trailer chunk arrives: partial
              // output only, and wait() below still reports the shell's
              // own exit 0.
              return;
            }
            // Echo the sentinel the provider actually asked for, so a nonce
            // in the trailer stays honest instead of being hardcoded here.
            const sentinel =
              /__MAKEADEMO_EXIT_[A-Za-z0-9]+__/.exec(String(data))?.[0] ??
              "__MAKEADEMO_EXIT__";
            ptyOptions.onData(new TextEncoder().encode(`\n${sentinel}:7\n`));
          },
          async kill() {
            calls.push({ kill: true });
            resolveDisconnect?.();
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
        if (!sandboxStarted) {
          throw new Error(
            "bad request: failed to resolve container IP after 3 attempts: no IP address found. Is the Sandbox started?",
          );
        }
        if (
          command.includes("tail -c") &&
          command.includes("/tmp/makeademo/sandbox-log.jsonl")
        ) {
          if (
            sandboxLogCollect502Failures <
            (options.sandboxLogCollect502FailuresBeforeSuccess ?? 0)
          ) {
            sandboxLogCollect502Failures += 1;
            throw Object.assign(
              new Error("Request failed with status code 502"),
              { statusCode: 502 },
            );
          }
          return {
            exitCode: 0,
            result: options.sandboxLogContents ?? "",
          };
        }
        if (
          command.includes(">> '/tmp/makeademo/sandbox-log.jsonl'") &&
          sandboxLogWrite502Failures <
            (options.sandboxLogWrite502FailuresBeforeSuccess ?? 0)
        ) {
          sandboxLogWrite502Failures += 1;
          throw Object.assign(
            new Error("Request failed with status code 502"),
            { statusCode: 502 },
          );
        }
        if (
          !command.includes("/tmp/makeademo/sandbox-log.jsonl") &&
          executeCommand502Failures <
            (options.executeCommand502FailuresBeforeSuccess ?? 0)
        ) {
          executeCommand502Failures += 1;
          throw Object.assign(
            new Error("Request failed with status code 502"),
            { statusCode: 502 },
          );
        }
        if (options.executeCommandFails === true) {
          throw new Error("executeCommand failed");
        }
        if (options.executeCommandNeverResolves === true) {
          await new Promise(() => {});
        }
        if (options.executeCommandOmitsExitCode === true) {
          return { result: "ok" };
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
    async refreshData() {
      calls.push({ refreshData: true });
    },
    async start(timeout?: number) {
      calls.push({ start: timeout });
      if (options.sandboxRestartDoesNotRecover !== true) {
        sandboxStarted = true;
      }
    },
    async updateNetworkSettings(settings: unknown) {
      calls.push({ updateNetworkSettings: settings });
      if (
        options.networkError !== undefined &&
        (options.networkFailuresBeforeSuccess === undefined ||
          networkFailures < options.networkFailuresBeforeSuccess)
      ) {
        networkFailures += 1;
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
