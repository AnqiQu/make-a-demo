import { posix } from "node:path";
import { isEnvironmentFileName } from "../repo-security/secret-predicates";
import type { RequiredService } from "../schemas/artifacts";

type RequiredServiceFile = {
  path: string;
  text?: string;
};

/**
 * The normalized service vocabulary. Detection maps every repo-declared
 * signal onto one of these names; enforcement and the rung ladder reason
 * about the normalized name, never the raw signal. A new backend class
 * enters the ladder by extending these signal tables together with a
 * fixture-repo test — never by special-casing one repository.
 */
type ServiceName = "mongodb" | "mysql" | "postgres" | "redis";

const composeFileNamePattern = /^(?:docker-)?compose(?:\..+)?\.ya?ml$/;

const composeImageServices: Array<[RegExp, ServiceName]> = [
  [/^(?:postgres|postgis|pgvector|timescaledb)/, "postgres"],
  [/^(?:mysql|mariadb|percona)/, "mysql"],
  [/^mongo/, "mongodb"],
  [/^(?:redis|valkey|keydb)/, "redis"],
];

const environmentUrlSchemes: Array<[RegExp, ServiceName]> = [
  [/\bpostgres(?:ql)?:\/\//, "postgres"],
  [/\bmysql:\/\//, "mysql"],
  [/\bmongodb(?:\+srv)?:\/\//, "mongodb"],
  [/\brediss?:\/\//, "redis"],
];

const prismaProviderServices: Record<string, ServiceName> = {
  mongodb: "mongodb",
  mysql: "mysql",
  postgres: "postgres",
  postgresql: "postgres",
};

const ormClientServices: Record<string, ServiceName> = {
  mariadb: "mysql",
  mongodb: "mongodb",
  mysql: "mysql",
  mysql2: "mysql",
  pg: "postgres",
  postgres: "postgres",
  postgresql: "postgres",
};

const driverDependencyServices: Record<string, ServiceName> = {
  ioredis: "redis",
  mongodb: "mongodb",
  mongoose: "mongodb",
  mysql: "mysql",
  mysql2: "mysql",
  pg: "postgres",
  "pg-promise": "postgres",
  postgres: "postgres",
  redis: "redis",
};

const embeddedSqliteDependencies = new Set([
  "@libsql/client",
  "better-sqlite3",
  "libsql",
  "sql.js",
  "sqlite3",
]);

const embeddedSqliteConfigValues = new Set([
  "better-sqlite3",
  "sqlite",
  "sqlite3",
  "turso",
]);

/** Only relational services have a sqlite-shaped embedded stand-in. */
const embeddedCapableServices = new Set<ServiceName>(["mysql", "postgres"]);

const evidencePathCap = 8;

/**
 * Reads the repo-declared data-service signals — docker-compose services,
 * environment-file URL schemes, the Prisma datasource provider, knex /
 * drizzle / typeorm configuration, and installed driver dependencies — into
 * a normalized `servicesRequired` inventory with evidence paths (N122).
 * Pure over the screened file list: files without text contribute nothing.
 * SQLite signals never produce an entry; they mark the embedded alternative
 * on relational entries instead, steering the embedded-config rung.
 */
export function detectRequiredServices(
  files: RequiredServiceFile[],
): RequiredService[] {
  const evidenceByService = new Map<ServiceName, Set<string>>();
  const embeddedEvidencePaths = new Set<string>();
  const record = (service: ServiceName, path: string) => {
    const evidence = evidenceByService.get(service) ?? new Set<string>();
    evidence.add(path);
    evidenceByService.set(service, evidence);
  };

  for (const file of files) {
    if (file.text === undefined) continue;
    const name = posix.basename(file.path);

    if (composeFileNamePattern.test(name)) {
      for (const match of file.text.matchAll(
        /(?:^|\n)\s*image\s*:\s*["']?([^\s"'#]+)/g,
      )) {
        const image = match[1]?.split("/").at(-1) ?? "";
        for (const [pattern, service] of composeImageServices) {
          if (pattern.test(image)) record(service, file.path);
        }
      }
    }

    if (isEnvironmentFileName(file.path)) {
      for (const [pattern, service] of environmentUrlSchemes) {
        if (pattern.test(file.text)) record(service, file.path);
      }
    }

    if (name.endsWith(".prisma")) {
      for (const match of file.text.matchAll(
        /\bprovider\s*=\s*["']([\w-]+)["']/g,
      )) {
        const provider = match[1]?.toLowerCase() ?? "";
        const service = prismaProviderServices[provider];
        if (service !== undefined) record(service, file.path);
        if (provider === "sqlite") embeddedEvidencePaths.add(file.path);
      }
    }

    if (isOrmConfigFileName(name)) {
      for (const match of file.text.matchAll(
        /\b(?:client|dialect|type)["']?\s*:\s*["'`]([\w@/.-]+)["'`]/g,
      )) {
        const client = match[1]?.toLowerCase() ?? "";
        const service = ormClientServices[client];
        if (service !== undefined) record(service, file.path);
        if (embeddedSqliteConfigValues.has(client)) {
          embeddedEvidencePaths.add(file.path);
        }
      }
    }

    if (name === "package.json") {
      for (const dependency of readDeclaredDependencyNames(file.text)) {
        const service = driverDependencyServices[dependency];
        if (service !== undefined) record(service, file.path);
        if (embeddedSqliteDependencies.has(dependency)) {
          embeddedEvidencePaths.add(file.path);
        }
      }
    }
  }

  const embeddedEvidence = [...embeddedEvidencePaths]
    .sort()
    .slice(0, evidencePathCap);
  return [...evidenceByService.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([service, evidence]) => ({
      ...(embeddedCapableServices.has(service) && embeddedEvidence.length > 0
        ? { embeddedAlternativeEvidencePaths: embeddedEvidence }
        : {}),
      evidencePaths: [...evidence].sort().slice(0, evidencePathCap),
      service,
    }));
}

function isOrmConfigFileName(name: string): boolean {
  return (
    /^knexfile\.[cm]?[jt]s$/.test(name) ||
    /^drizzle\.config(?:\..+)?\.[cm]?[jt]s$/.test(name) ||
    /^ormconfig\.(?:json|[cm]?[jt]s)$/.test(name) ||
    /^data-source\.[cm]?[jt]s$/.test(name)
  );
}

function readDeclaredDependencyNames(text: string): string[] {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return [
      json.dependencies,
      json.devDependencies,
      json.optionalDependencies,
    ].flatMap((section) =>
      typeof section === "object" && section !== null && !Array.isArray(section)
        ? Object.keys(section)
        : [],
    );
  } catch {
    return [];
  }
}
