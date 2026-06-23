export type BenchmarkMode = "full" | "stage1";

export type BenchmarkStatusLevel =
  | "L0"
  | "L1"
  | "L2"
  | "L3"
  | "L4"
  | "L5"
  | "L6";

type BenchmarkManifestDefaults = {
  daytonaSnapshot?: string;
  mode?: BenchmarkMode;
  model?: string;
  outputRoot?: string;
  provider?: string;
  repetitions?: number;
};

type BenchmarkRepoSpec = {
  categories: string[];
  commitSha?: string;
  daytonaSnapshot?: string;
  docs?: string[];
  expectedLevel: BenchmarkStatusLevel;
  features: string[];
  id: string;
  mode?: BenchmarkMode;
  model?: string;
  provider?: string;
  repoUrl: string;
  repetitions?: number;
  workspaceId?: string;
};

export type BenchmarkManifest = {
  defaults: BenchmarkManifestDefaults;
  repos: BenchmarkRepo[];
  version: 1;
};

export type BenchmarkRepo = BenchmarkRepoSpec & {
  docs: string[];
  effectiveDaytonaSnapshot?: string;
  effectiveMode: BenchmarkMode;
  effectiveModel: string;
  effectiveProvider: string;
  effectiveRepetitions: number;
};

export type BenchmarkPipelineArgsInput = {
  outputRoot: string;
  repo: BenchmarkRepo;
};

export function readBenchmarkManifest(value: unknown): BenchmarkManifest {
  const record = readRecord(value, "benchmark manifest");
  const version = readNumber(record.version, "version");
  if (version !== 1) {
    throw new Error(`Unsupported benchmark manifest version: ${version}`);
  }

  const defaults = readDefaults(record.defaults);
  const repos = readArray(record.repos, "repos").map((repo, index) =>
    readRepo(repo, defaults, `repos[${index}]`),
  );
  assertUniqueRepoIds(repos);

  return { defaults, repos, version: 1 };
}

export function buildBenchmarkPipelineArgs(input: BenchmarkPipelineArgsInput) {
  const cliPath =
    input.repo.effectiveMode === "stage1"
      ? "src/server/shared/pipeline-runner/stage1-cli.mts"
      : "src/server/shared/pipeline-runner/full-pipeline-cli.mts";
  const args = [cliPath];

  if (input.repo.effectiveMode === "full") {
    args.push("--output-root", input.outputRoot);
  }

  args.push("--repo", input.repo.repoUrl);
  for (const feature of input.repo.features) {
    args.push("--feature", feature);
  }
  for (const doc of input.repo.docs) {
    args.push("--doc", doc);
  }

  return args;
}

function readDefaults(value: unknown): BenchmarkManifestDefaults {
  if (value === undefined) {
    return {};
  }

  const record = readRecord(value, "defaults");
  return omitUndefined({
    daytonaSnapshot: readOptionalString(
      record.daytonaSnapshot,
      "defaults.daytonaSnapshot",
    ),
    mode: readOptionalMode(record.mode, "defaults.mode"),
    model: readOptionalString(record.model, "defaults.model"),
    outputRoot: readOptionalString(record.outputRoot, "defaults.outputRoot"),
    provider: readOptionalString(record.provider, "defaults.provider"),
    repetitions: readOptionalPositiveInteger(
      record.repetitions,
      "defaults.repetitions",
    ),
  });
}

function readRepo(
  value: unknown,
  defaults: BenchmarkManifestDefaults,
  path: string,
): BenchmarkRepo {
  const record = readRecord(value, path);
  const mode =
    readOptionalMode(record.mode, `${path}.mode`) ?? defaults.mode ?? "stage1";
  const model =
    readOptionalString(record.model, `${path}.model`) ??
    defaults.model ??
    "gpt-5.5";
  const provider =
    readOptionalString(record.provider, `${path}.provider`) ??
    defaults.provider ??
    "openai";
  const repetitions =
    readOptionalPositiveInteger(record.repetitions, `${path}.repetitions`) ??
    defaults.repetitions ??
    1;
  const daytonaSnapshot =
    readOptionalString(record.daytonaSnapshot, `${path}.daytonaSnapshot`) ??
    defaults.daytonaSnapshot;

  return omitUndefined({
    categories: readStringArray(record.categories, `${path}.categories`),
    commitSha: readOptionalString(record.commitSha, `${path}.commitSha`),
    daytonaSnapshot: readOptionalString(
      record.daytonaSnapshot,
      `${path}.daytonaSnapshot`,
    ),
    docs: readOptionalStringArray(record.docs, `${path}.docs`) ?? [],
    effectiveDaytonaSnapshot: daytonaSnapshot,
    effectiveMode: mode,
    effectiveModel: model,
    effectiveProvider: provider,
    effectiveRepetitions: repetitions,
    expectedLevel: readStatusLevel(
      record.expectedLevel,
      `${path}.expectedLevel`,
    ),
    features: readStringArray(record.features, `${path}.features`),
    id: readString(record.id, `${path}.id`),
    mode: readOptionalMode(record.mode, `${path}.mode`),
    model: readOptionalString(record.model, `${path}.model`),
    provider: readOptionalString(record.provider, `${path}.provider`),
    repoUrl: readString(record.repoUrl, `${path}.repoUrl`),
    repetitions: readOptionalPositiveInteger(
      record.repetitions,
      `${path}.repetitions`,
    ),
    workspaceId: readOptionalString(record.workspaceId, `${path}.workspaceId`),
  });
}

function assertUniqueRepoIds(repos: BenchmarkRepo[]) {
  const seen = new Set<string>();
  for (const repo of repos) {
    if (seen.has(repo.id)) {
      throw new Error(`Duplicate benchmark repo id: ${repo.id}`);
    }
    seen.add(repo.id);
  }
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }

  return value;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }

  return value;
}

function readOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readString(value, path);
}

function readNumber(value: unknown, path: string): number {
  if (typeof value !== "number") {
    throw new Error(`${path} must be a number`);
  }

  return value;
}

function readOptionalPositiveInteger(
  value: unknown,
  path: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer`);
  }

  return value;
}

function readStringArray(value: unknown, path: string): string[] {
  return readArray(value, path).map((item, index) =>
    readString(item, `${path}[${index}]`),
  );
}

function readOptionalStringArray(
  value: unknown,
  path: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readStringArray(value, path);
}

function readOptionalMode(
  value: unknown,
  path: string,
): BenchmarkMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== "full" && value !== "stage1") {
    throw new Error(`${path} must be "full" or "stage1"`);
  }

  return value;
}

function readStatusLevel(value: unknown, path: string): BenchmarkStatusLevel {
  if (
    value !== "L0" &&
    value !== "L1" &&
    value !== "L2" &&
    value !== "L3" &&
    value !== "L4" &&
    value !== "L5" &&
    value !== "L6"
  ) {
    throw new Error(`${path} must be one of L0, L1, L2, L3, L4, L5, or L6`);
  }

  return value;
}

function omitUndefined<T extends Record<string, unknown>>(record: T) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as {
    [K in keyof T as undefined extends T[K] ? K : K]: Exclude<T[K], undefined>;
  };
}
