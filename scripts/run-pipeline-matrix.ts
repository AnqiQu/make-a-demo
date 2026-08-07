// Opt-in acceptance gate for the remediation plan (docs/audits/2026-07-27-remediation-plan.md,
// Phase 0.3): runs the full demo pipeline against the configured repo matrix and writes a
// pass/fail report. Each entry costs real Daytona/agent money — run deliberately.
//
// Runnable entries run concurrently, each in its own sandbox, so peak sandbox
// usage (and cost at any instant) scales with the number of selected entries.
// Use --only to bound the batch when that peak matters.
//
//   bun run pipeline:matrix                 # all configured entries
//   bun run pipeline:matrix -- --only vite-spa,midday
//
// Fixture entries need a GitHub mirror before they can run (the pipeline only accepts
// https://github.com/owner/repo URLs); see tests/fixtures/repos/README.md.
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type DefaultDemoPipelineInput,
  type DefaultDemoPipelineResult,
  runDefaultDemoPipeline,
} from "../src/server/agent-harness/default/default-demo-pipeline";

export type MatrixEntryConfig = {
  demoLengthSeconds?: number;
  fixtureDir?: string;
  importantFeatures?: string[];
  name: string;
  preferredAppDir?: string;
  productSummary?: string;
  repoUrl?: string;
  targetUsers?: string;
};

export type ResolvedMatrixEntry =
  | { input: DefaultDemoPipelineInput; name: string; status: "runnable" }
  | { name: string; reason: string; status: "skipped" };

export type MatrixEntryResult = {
  detail: string;
  durationMs?: number;
  name: string;
  runDirectory?: string;
  status: "passed" | "failed" | "skipped";
};

export function matrixRepoEnvVar(entryName: string): string {
  return `MAKEADEMO_MATRIX_REPO_${entryName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export function resolveMatrixEntries(
  entries: MatrixEntryConfig[],
  env: Record<string, string | undefined>,
): ResolvedMatrixEntry[] {
  return entries.map((entry) => {
    const repoUrl = env[matrixRepoEnvVar(entry.name)]?.trim() || entry.repoUrl;
    if (repoUrl === undefined || repoUrl.length === 0) {
      const source =
        entry.fixtureDir === undefined
          ? "the repo"
          : `${entry.fixtureDir} to a GitHub repo you own`;
      return {
        name: entry.name,
        reason:
          `no repo URL configured — push ${source} and set ` +
          `${matrixRepoEnvVar(entry.name)} or the repoUrl field in the matrix config`,
        status: "skipped",
      };
    }
    return {
      input: {
        demoLengthSeconds: entry.demoLengthSeconds ?? 30,
        importantFeatures: entry.importantFeatures ?? [],
        ...(entry.preferredAppDir === undefined
          ? {}
          : { preferredAppDir: entry.preferredAppDir }),
        ...(entry.productSummary === undefined
          ? {}
          : { productSummary: entry.productSummary }),
        repoUrl,
        ...(entry.targetUsers === undefined
          ? {}
          : { targetUsers: entry.targetUsers }),
      },
      name: entry.name,
      status: "runnable",
    };
  });
}

/**
 * Builds a filesystem-safe run id that is unique per matrix entry within a
 * batch. Every entry in one `runPipelineMatrix` call shares `batchStamp`, and
 * the entry name (unique across the matrix config) disambiguates the rest, so
 * concurrent runs never share `runDefaultDemoPipeline`'s output directory even
 * though they all start in the same millisecond.
 */
function matrixRunId(entryName: string, batchStamp: string): string {
  const slug = entryName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `matrix-${batchStamp}-${slug}`;
}

/**
 * Runs every runnable entry concurrently, each in its own sandbox via
 * `runPipeline`, and keeps report rows in entry order regardless of which run
 * finishes first. A failing entry becomes a `failed` row without aborting the
 * others. `runPipeline` receives a per-entry `runId` so concurrent runs write
 * to distinct output directories.
 */
export async function runPipelineMatrix(
  entries: ResolvedMatrixEntry[],
  options: {
    log: (message: string) => void;
    runPipeline?: (
      input: DefaultDemoPipelineInput,
      runId: string,
    ) => Promise<DefaultDemoPipelineResult>;
  },
): Promise<MatrixEntryResult[]> {
  const runPipeline =
    options.runPipeline ??
    ((input, runId) => runDefaultDemoPipeline(input, { runId }));
  const batchStamp = new Date().toISOString().replace(/[:.]/g, "-");
  return Promise.all(
    entries.map(async (entry): Promise<MatrixEntryResult> => {
      if (entry.status === "skipped") {
        options.log(`skipping ${entry.name}: ${entry.reason}`);
        return {
          detail: entry.reason,
          name: entry.name,
          status: "skipped",
        };
      }
      options.log(`running ${entry.name} (${entry.input.repoUrl})`);
      const startedAt = Date.now();
      try {
        const result = await runPipeline(
          entry.input,
          matrixRunId(entry.name, batchStamp),
        );
        options.log(`passed ${entry.name}`);
        return {
          detail: result.finalVideoPath,
          durationMs: Date.now() - startedAt,
          name: entry.name,
          runDirectory: result.runDirectory,
          status: "passed",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.log(`failed ${entry.name}: ${readFailureDetail(message)}`);
        return {
          detail: readFailureDetail(message),
          durationMs: Date.now() - startedAt,
          name: entry.name,
          status: "failed",
        };
      }
    }),
  );
}

/**
 * A failure's first line ends with a bare colon when the informative payload
 * (a subprocess's output) starts on a later line — keep that payload in the
 * one-line report detail instead of truncating to an empty suffix.
 */
function readFailureDetail(message: string): string {
  const firstLine = message.split("\n", 1)[0] ?? message;
  if (!/:\s*$/.test(firstLine)) {
    return firstLine;
  }
  const continuation = message
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return continuation === undefined
    ? firstLine
    : `${firstLine.trimEnd()} ${continuation}`;
}

/**
 * Warns when `pmset -g batt` reports battery power: closing the lid then
 * sleeps the host, freezing the local orchestrator while paid sandbox agents
 * keep working — on wake the stale watchdogs kill them (N27, 2026-08-03 run).
 * Returns undefined on AC power or when the power state is unreadable.
 */
export function batteryPowerWarning(pmsetStdout: string): string | undefined {
  if (!pmsetStdout.includes("Battery Power")) {
    return undefined;
  }
  return (
    "running on battery — closing the lid sleeps this orchestrator and kills " +
    "in-flight sandbox agents; plug in or keep the lid open for the whole run"
  );
}

// caffeinate prevents idle sleep for this process's lifetime (it cannot
// prevent clamshell sleep on battery — hence the warning above).
async function guardAgainstHostSleep(log: (message: string) => void) {
  if (process.platform !== "darwin") {
    return;
  }
  spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" })
    .once("error", () => log("caffeinate unavailable — idle sleep not held"))
    .unref();
  try {
    const { stdout } = await promisify(execFile)("pmset", ["-g", "batt"]);
    const warning = batteryPowerWarning(stdout);
    if (warning !== undefined) {
      log(warning);
    }
  } catch {
    // Power-state introspection is diagnostic only; never block the run.
  }
}

export function renderMatrixReport(results: MatrixEntryResult[]): string {
  const lines = [
    "| Entry | Status | Duration | Detail |",
    "|---|---|---|---|",
    ...results.map((result) => {
      const duration =
        result.durationMs === undefined
          ? "—"
          : `${Math.round(result.durationMs / 1000)}s`;
      return `| ${result.name} | ${result.status} | ${duration} | ${result.detail} |`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

const matrixConfigPath = "tests/fixtures/pipeline-matrix.json";

async function main(): Promise<void> {
  const config = JSON.parse(await readFile(matrixConfigPath, "utf8")) as {
    entries: MatrixEntryConfig[];
  };
  const onlyArgument = process.argv.indexOf("--only");
  const only =
    onlyArgument === -1
      ? undefined
      : new Set(
          (process.argv[onlyArgument + 1] ?? "")
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
        );
  const configured =
    only === undefined
      ? config.entries
      : config.entries.filter((entry) => only.has(entry.name));
  if (configured.length === 0) {
    throw new Error(
      `No matrix entries selected from ${matrixConfigPath}${
        only === undefined ? "" : ` matching --only ${[...only].join(",")}`
      }.`,
    );
  }

  const log = (message: string) =>
    process.stdout.write(`[matrix] ${message}\n`);
  await guardAgainstHostSleep(log);
  const entries = resolveMatrixEntries(configured, process.env);
  const results = await runPipelineMatrix(entries, { log });

  const report = renderMatrixReport(results);
  const reportPath = join(
    ".makeademo-terminal-runs",
    `matrix-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(reportPath, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`\n${report}\nReport written to ${reportPath}\n`);
  if (results.some((result) => result.status === "failed")) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
