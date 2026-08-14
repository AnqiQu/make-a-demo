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
  type BulkTransferLimiter,
  createBulkTransferLimiter,
} from "../src/server/agent-harness/default/bulk-transfer-limiter";
import {
  type DefaultDemoPipelineInput,
  type DefaultDemoPipelineResult,
  runDefaultDemoPipeline,
} from "../src/server/agent-harness/default/default-demo-pipeline";
import { destroyAllDaytonaWorkspaces } from "../src/server/shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";
import type { MatrixRunEmailNotifier } from "../src/server/shared/integrations/email/matrix-run-email-notifier.interface";
import { ResendMatrixRunEmailNotifier } from "../src/server/shared/integrations/email/resend-matrix-run-email-notifier";

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

const launchStaggerMinimumMs = 30_000;
const launchStaggerJitterMs = 30_000;

/**
 * Cumulative launch offset per entry: the first runnable entry starts
 * immediately, each later one 30-60s after the previous. Skipped entries
 * consume no slot.
 */
function computeLaunchOffsets(
  entries: ResolvedMatrixEntry[],
  random: () => number,
): number[] {
  let offsetMs = 0;
  let firstRunnable = true;
  return entries.map((entry) => {
    if (entry.status !== "runnable") {
      return 0;
    }
    if (firstRunnable) {
      firstRunnable = false;
      return 0;
    }
    offsetMs += launchStaggerMinimumMs + random() * launchStaggerJitterMs;
    return offsetMs;
  });
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
    /**
     * Spreads runnable launches 30-60s apart. A whole matrix created in the
     * same second is its own control-plane herd (2026-08-09): the batch
     * queues behind its own state changes and synchronizes onto every
     * conflict window. Off by default so single-entry callers and tests
     * keep instant launches; `main` enables it.
     */
    launchStagger?: {
      random?: () => number;
      sleep?: (delayMs: number) => Promise<void>;
    };
    log: (message: string) => void;
    runPipeline?: (
      input: DefaultDemoPipelineInput,
      runId: string,
      batch: { bulkTransferLimiter: BulkTransferLimiter },
    ) => Promise<DefaultDemoPipelineResult>;
  },
): Promise<MatrixEntryResult[]> {
  // One limiter per batch: every entry's clone and archive upload share the
  // developer uplink, and unserialized they starve each other mid-stream
  // (calcom and ghostfolio's clones died behind twenty's 294MB upload,
  // 2026-08-13T23-23).
  const batch = { bulkTransferLimiter: createBulkTransferLimiter() };
  const runPipeline =
    options.runPipeline ??
    ((input: DefaultDemoPipelineInput, runId: string) =>
      runDefaultDemoPipeline(input, {
        bulkTransferLimiter: batch.bulkTransferLimiter,
        runId,
      }));
  const batchStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stagger = options.launchStagger;
  const launchOffsetsMs =
    stagger === undefined
      ? undefined
      : computeLaunchOffsets(entries, stagger.random ?? Math.random);
  const sleep =
    stagger?.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  return Promise.all(
    entries.map(async (entry, entryIndex): Promise<MatrixEntryResult> => {
      if (entry.status === "skipped") {
        options.log(`skipping ${entry.name}: ${entry.reason}`);
        return {
          detail: entry.reason,
          name: entry.name,
          status: "skipped",
        };
      }
      const launchOffsetMs = launchOffsetsMs?.[entryIndex] ?? 0;
      if (launchOffsetMs > 0) {
        options.log(
          `holding ${entry.name} launch for ${Math.round(launchOffsetMs / 1000)}s to spread control-plane load`,
        );
        await sleep(launchOffsetMs);
      }
      options.log(`running ${entry.name} (${entry.input.repoUrl})`);
      const startedAt = Date.now();
      try {
        const result = await runPipeline(
          entry.input,
          matrixRunId(entry.name, batchStamp),
          batch,
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

/** A report row stays scannable; anything longer belongs in the JSONL. */
const failureDetailHeadChars = 240;

/**
 * A failure's first line ends with a bare colon when the informative payload
 * (a subprocess's output) starts on a later line — keep that payload in the
 * one-line report detail instead of truncating to an empty suffix. A first
 * line that inlines a whole command excerpt is bounded, and the message's
 * last `[makeademo:…]` marker line rides along: markers are the recorded
 * facts (exit codes, timeouts, peaks) that diagnosis actually needs
 * (ghost's report row was mid-word compiler garbage while the exit=124
 * trailer sat at the end, 2026-08-09). Without a marker, git's last
 * `fatal:`/`error:` line rides along instead: a clone failure's first line
 * is "Cloning into …" while the trailing fatal: line names the real cause
 * (calcom and ghostfolio's mid-transfer exit-128s, 2026-08-13T23-23).
 */
function readFailureDetail(message: string): string {
  const firstLine = message.split("\n", 1)[0] ?? message;
  const head =
    firstLine.length > failureDetailHeadChars
      ? `${firstLine.slice(0, failureDetailHeadChars)}…`
      : firstLine;
  const lines = message.split("\n");
  const marker = lines
    .filter((line) => line.trim().startsWith("[makeademo:"))
    .at(-1)
    ?.trim();
  const fatalLine = lines
    .filter((line) => /^(?:fatal|error):/.test(line.trim()))
    .at(-1)
    ?.trim();
  const rideAlong = marker ?? fatalLine;
  if (rideAlong !== undefined && !head.includes(rideAlong)) {
    return `${head} … ${rideAlong}`;
  }
  if (!/:\s*$/.test(head)) {
    return head;
  }
  const continuation = message
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return continuation === undefined
    ? head
    : `${head.trimEnd()} ${continuation}`;
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

export type MatrixNotification =
  | { status: "disabled" }
  | { reason: string; status: "misconfigured" }
  | { apiKey: string; fromEmail: string; status: "enabled"; to: string };

/**
 * Resolves whether a finished matrix batch should be emailed. Opt in with
 * `TEXTME=1|true` and a `TEXTME_EMAIL` recipient; the send reuses the same
 * `RESEND_API_KEY`/`RESEND_FROM_EMAIL` as the final-video email. Returns
 * `misconfigured` (never throws) when the flag is on but a required value is
 * missing, so a batch still reports its result instead of crashing at the end.
 */
export function resolveMatrixNotification(
  env: Record<string, string | undefined>,
): MatrixNotification {
  const flag = env.TEXTME?.trim().toLowerCase();
  if (flag !== "1" && flag !== "true") {
    return { status: "disabled" };
  }
  const to = env.TEXTME_EMAIL?.trim();
  const apiKey = env.RESEND_API_KEY?.trim();
  const fromEmail = env.RESEND_FROM_EMAIL?.trim();
  if (to && apiKey && fromEmail) {
    return { apiKey, fromEmail, status: "enabled", to };
  }
  const missing = [
    to ? undefined : "TEXTME_EMAIL",
    apiKey ? undefined : "RESEND_API_KEY",
    fromEmail ? undefined : "RESEND_FROM_EMAIL",
  ].filter((name): name is string => name !== undefined);
  return {
    reason: `TEXTME is on but ${missing.join(", ")} ${
      missing.length === 1 ? "is" : "are"
    } not set`,
    status: "misconfigured",
  };
}

function countMatrixStatuses(results: MatrixEntryResult[]) {
  return {
    failed: results.filter((result) => result.status === "failed").length,
    passed: results.filter((result) => result.status === "passed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
  };
}

/**
 * Emails the finished matrix report when `TEXTME` opts in. A notification
 * failure is logged and swallowed: it must never fail an otherwise-successful
 * batch or mask its exit code, since the run's real work is already done by the
 * time this fires. Tests inject `notifier`; production builds the Resend one
 * from the reused credentials.
 */
export async function notifyMatrixRunComplete(input: {
  batchStamp: string;
  env: Record<string, string | undefined>;
  log: (message: string) => void;
  notifier?: MatrixRunEmailNotifier;
  reportMarkdown: string;
  results: MatrixEntryResult[];
}): Promise<void> {
  const notification = resolveMatrixNotification(input.env);
  if (notification.status === "disabled") {
    return;
  }
  if (notification.status === "misconfigured") {
    input.log(`skipping run notification: ${notification.reason}`);
    return;
  }
  const notifier =
    input.notifier ??
    new ResendMatrixRunEmailNotifier({
      apiKey: notification.apiKey,
      fromEmail: notification.fromEmail,
    });
  const counts = countMatrixStatuses(input.results);
  try {
    await notifier.sendMatrixRunReportEmail({
      batchStamp: input.batchStamp,
      failed: counts.failed,
      passed: counts.passed,
      reportMarkdown: input.reportMarkdown,
      skipped: counts.skipped,
      to: notification.to,
    });
    input.log(`emailed run report to ${notification.to}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.log(`run notification failed (matrix result unaffected): ${message}`);
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
  const results = await runPipelineMatrix(entries, { launchStagger: {}, log });

  const report = renderMatrixReport(results);
  const reportStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = join(
    ".makeademo-terminal-runs",
    `matrix-report-${reportStamp}.json`,
  );
  await writeFile(reportPath, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`\n${report}\nReport written to ${reportPath}\n`);
  await notifyMatrixRunComplete({
    batchStamp: reportStamp,
    env: process.env,
    log,
    reportMarkdown: report,
    results,
  });
  if (results.some((result) => result.status === "failed")) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  // An interrupted matrix must not orphan its Daytona sandboxes: without
  // this, every live sandbox keeps billing until the server-side
  // auto-delete backstop reaps it (18 orphans from one aborted run,
  // 2026-08-08).
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      process.stdout.write(
        `[matrix] ${signal} received; deleting live Daytona sandboxes before exit...\n`,
      );
      void destroyAllDaytonaWorkspaces().finally(() => process.exit(130));
    });
  }
  await main();
}
