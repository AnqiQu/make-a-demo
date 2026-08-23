import path from "node:path/posix";
import { withCpuLivenessHeartbeat } from "../../shared/shell/cpu-liveness";
import { shellQuote } from "../../shared/shell/shell-quote";
import { elideMiddle } from "../../shared/text/elide-middle";
import {
  makeADemoDirectory,
  stageWriteableArtifactPaths,
} from "../schemas/artifact-paths";
import { createAgentLivenessPluginSource } from "./agent-liveness-plugin";
import type {
  OpenCodeHarnessRunInput,
  OpenCodeHarnessRunResult,
  OpenCodeHarnessRunner,
} from "./opencode-harness";

export class DefaultOpenCodeHarnessRunner implements OpenCodeHarnessRunner {
  async run(input: OpenCodeHarnessRunInput): Promise<OpenCodeHarnessRunResult> {
    // The prompt travels by file: a single-line shell argument would pass
    // through the sandbox PTY's canonical line discipline, which truncates
    // lines around 4KB (MAX_CANON) and silently corrupts large prompts.
    // The file still expands into one execve argument via "$(cat …)", and
    // Linux caps a single argument around 128KB (MAX_ARG_STRLEN) — past it,
    // OpenCode exits 126 without launching. Elide the middle as a last
    // resort; prompt builders are expected to stay under this on their own.
    const promptPath = `${input.configDir}/prompt-${input.stage}.txt`;
    await input.workspace.writeTextFile(
      promptPath,
      elideMiddle(input.prompt, 96_000),
    );
    // OpenCode auto-loads plugins from `<configDir>/plugin/`; this one
    // turns model event-bus activity into throttled stderr beats so a
    // PTY-silent but working agent keeps feeding the inactivity watchdog.
    await input.workspace.writeTextFile(
      `${input.configDir}/plugin/agent-liveness.js`,
      createAgentLivenessPluginSource(),
    );
    const result = await input.workspace.execute(
      createOpenCodeRunCommand({
        configDir: input.configDir,
        model: input.model,
        promptPath,
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId }),
        workingDirectory: input.workingDirectory,
      }),
      {
        env: {
          OPENCODE_CONFIG_DIR: input.configDir,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(
            createStageSecurityConfig(input),
          ),
          OPENCODE_ENABLE_EXA: "0",
        },
        ...(input.activityFilter === undefined
          ? {}
          : { activityFilter: input.activityFilter }),
        ...(input.inactivityTimeoutMs === undefined
          ? {}
          : { inactivityTimeoutMs: input.inactivityTimeoutMs }),
        ...(input.onStderr === undefined ? {} : { onStderr: input.onStderr }),
        ...(input.onStdout === undefined ? {} : { onStdout: input.onStdout }),
        timeoutMs: input.timeoutMs,
      },
    );

    const sessionId = input.sessionId ?? readSessionId(result);
    return {
      ...result,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }
}

function createOpenCodeRunCommand(input: {
  configDir: string;
  model: string;
  promptPath: string;
  sessionId?: string;
  workingDirectory: string;
}): string {
  // The CPU-liveness bracket keeps the no-output inactivity watchdog fed
  // while OpenCode works silently inside a long tool call (43 working
  // agents killed in one matrix, 2026-08-09); a wedged, idle OpenCode
  // still goes quiet and dies at the inactivity deadline.
  return withCpuLivenessHeartbeat(
    [
      `mkdir -p ${shellQuote(input.configDir)} &&`,
      "opencode run",
      "--pure",
      "--dangerously-skip-permissions",
      "--format json",
      `--dir ${shellQuote(input.workingDirectory)}`,
      ...(input.sessionId === undefined
        ? []
        : [`--session ${shellQuote(input.sessionId)}`]),
      `--model ${shellQuote(input.model)}`,
      `"$(cat ${shellQuote(input.promptPath)})"`,
    ].join(" "),
  );
}

function createStageSecurityConfig(input: OpenCodeHarnessRunInput) {
  const canRead = input.availableTools.includes("read");
  const canWrite = input.availableTools.includes("write");
  const canRunShell = input.availableTools.includes("bash");

  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    instructions: [],
    permission: {
      "*": "deny",
      bash: canRunShell ? "allow" : "deny",
      doom_loop: "deny",
      edit: canWrite
        ? createStageEditPermissions(input.stage, input.workingDirectory)
        : "deny",
      external_directory: {
        "*": "deny",
        "/workspace/.makeademo/**": "allow",
      },
      glob: canRead ? "allow" : "deny",
      grep: canRead ? "allow" : "deny",
      question: "deny",
      read: canRead
        ? {
            "*": "allow",
            "**/.env": "deny",
            "**/.env.*": "deny",
            "**/*.env": "deny",
            "**/*.env.*": "deny",
            "**/.env.example": "allow",
          }
        : "deny",
      skill: "deny",
      task: "deny",
      webfetch: "deny",
      websearch: "deny",
    },
    plugin: [],
    share: "disabled",
  };
}

function createStageEditPermissions(
  stage: OpenCodeHarnessRunInput["stage"],
  workingDirectory: string,
) {
  const artifactPaths = stageWriteableArtifactPaths(stage);
  const artifactDirectory = makeADemoDirectory;
  const canMutateRepo =
    stage === "repo-preparation" || stage === "repo-preparation-repair";
  // Every artifact rule is registered under both its workingDirectory-relative
  // and absolute spelling: OpenCode matches globs against the path as the
  // model wrote it, so a single-spelling table made legal writes fail
  // nondeterministically (2026-08-03 homer flow-spec denial).
  return Object.fromEntries([
    ["*", "deny"],
    ...(canMutateRepo
      ? [
          ["**", "allow"],
          ["/workspace/repo/**", "allow"],
        ]
      : []),
    [`${path.relative(workingDirectory, artifactDirectory)}/**`, "deny"],
    [`${artifactDirectory}/**`, "deny"],
    ...artifactPaths.flatMap((artifactPath) => [
      [path.relative(workingDirectory, artifactPath), "allow"],
      [artifactPath, "allow"],
    ]),
  ]);
}

function readSessionId(result: {
  stderr: string;
  stdout: string;
}): string | undefined {
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const value = JSON.parse(trimmed) as { sessionID?: unknown };
      if (typeof value.sessionID === "string" && value.sessionID.length > 0) {
        return value.sessionID;
      }
    } catch {}
  }

  return undefined;
}
