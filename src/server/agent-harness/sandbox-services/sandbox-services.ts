import type { PreparationManifest } from "../schemas/artifacts";

/**
 * The provisioned-service rung of the data-backend ladder (N122(5)): real
 * data services booted inside the existing submitted-code sandbox, on
 * loopback only. No new sandboxes, no cross-sandbox networking, and Runtime
 * Network Lockdown untouched — the binaries ship in the snapshot and every
 * listener binds 127.0.0.1. Provisioning is reset-then-boot by design: each
 * call reinitializes the service from an empty data directory, so re-running
 * the manifest's migrate and seed commands afterwards yields identical demo
 * data on every preflight round.
 */
export type ProvisionableService = "mysql" | "postgres" | "redis";

export const provisionableServices: readonly ProvisionableService[] = [
  "mysql",
  "postgres",
  "redis",
];

/**
 * The loopback connection URLs the provisioned services answer on. The
 * manifest contract publishes these to the preparation agent, which wires
 * the app to them through envUsed; the harness guarantees a service booted
 * with `createServiceProvisionCommand` accepts exactly these credentials.
 */
export const sandboxServiceConnectionUrls: Record<
  ProvisionableService,
  string
> = {
  mysql: "mysql://makeademo:makeademo@127.0.0.1:3306/makeademo",
  postgres: "postgres://makeademo:makeademo@127.0.0.1:5432/makeademo",
  redis: "redis://127.0.0.1:6379",
};

/**
 * One provisioned-service declaration reduced to what the lifecycle
 * executes: boot `service`, then run `migrationCommand` and `seedCommand`
 * (each optional — apps that migrate on boot declare neither) in the app
 * directory through the guarded command wrapper.
 */
export type ProvisionedServicePlan = {
  service: ProvisionableService;
  migrationCommand?: string;
  seedCommand?: string;
};

/**
 * Reads the manifest's provisioned-service declarations into executable
 * plans. Declarations on other rungs contribute nothing. A
 * provisioned-service declaration for a service the sandbox cannot boot
 * throws — manifest enforcement rejects these earlier, so reaching one here
 * means the manifest bypassed validation and provisioning must not guess.
 */
export function readProvisionedServicePlans(
  dataStrategy: PreparationManifest["dataStrategy"],
): ProvisionedServicePlan[] {
  return (dataStrategy ?? [])
    .filter((declaration) => declaration.rung === "provisioned-service")
    .map((declaration) => {
      const service = declaration.service.trim().toLowerCase();
      if (!(provisionableServices as readonly string[]).includes(service)) {
        throw new Error(
          `dataStrategy declares provisioned-service for ${declaration.service}, but the sandbox can only provision: ${provisionableServices.join(", ")}. Choose another rung for this service.`,
        );
      }
      return {
        ...(declaration.migrationCommand === undefined
          ? {}
          : { migrationCommand: declaration.migrationCommand }),
        ...(declaration.seedCommand === undefined
          ? {}
          : { seedCommand: declaration.seedCommand }),
        service: service as ProvisionableService,
      };
    });
}

const servicesRoot = "/var/lib/makeademo-services";

/**
 * Builds the shell script that provisions one service: stop any prior
 * instance, reset its data directory, initialize, boot bound to loopback,
 * health-check until ready, and create the makeademo database and
 * credentials behind `sandboxServiceConnectionUrls`. Exits non-zero when the
 * service does not come up; the `[makeademo:service] <name> ready` marker on
 * stdout is the success evidence. Callers run it with `sh -ec` inside the
 * submitted-code sandbox — reset-then-boot makes the same script both the
 * first provision and the per-round reseed.
 */
export function createServiceProvisionCommand(
  service: ProvisionableService,
): string {
  const lines = {
    mysql: mysqlProvisionLines,
    postgres: postgresProvisionLines,
    redis: redisProvisionLines,
  }[service];
  return [
    `SERVICES_ROOT=${servicesRoot}`,
    'mkdir -p "$SERVICES_ROOT"',
    ...lines,
  ]
    .join("\n")
    .concat("\n");
}

// Debian's postgres packaging keeps initdb and pg_ctl off PATH under a
// versioned /usr/lib/postgresql prefix, and the server refuses to run as
// root — hence the bin-dir glob and `su postgres`. initdb's --username makes
// makeademo the superuser and trust auth accepts any password on loopback,
// so the published DSN's password is compatible without secret management.
const postgresProvisionLines = [
  'PGBIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -n 1)"',
  `su -s /bin/sh postgres -c "'$PGBIN/pg_ctl' -D '$SERVICES_ROOT/postgres' -m immediate stop" >/dev/null 2>&1 || true`,
  'rm -rf "$SERVICES_ROOT/postgres"',
  'mkdir -p "$SERVICES_ROOT/postgres"',
  'chown -R postgres "$SERVICES_ROOT/postgres"',
  `su -s /bin/sh postgres -c "'$PGBIN/initdb' --auth=trust --username=makeademo --pgdata='$SERVICES_ROOT/postgres'" >/dev/null`,
  `su -s /bin/sh postgres -c "'$PGBIN/pg_ctl' -D '$SERVICES_ROOT/postgres' -l '$SERVICES_ROOT/postgres/server.log' -o '-c listen_addresses=127.0.0.1 -p 5432' -w -t 60 start"`,
  "pg_isready -h 127.0.0.1 -p 5432 -t 30",
  "createdb -h 127.0.0.1 -p 5432 -U makeademo makeademo",
  'echo "[makeademo:service] postgres ready at 127.0.0.1:5432"',
];

// mariadb answers the mysql service class. Root administration goes through
// the unix socket (mariadb's root auth is unix_socket, and the sandbox shell
// is root); the app-facing makeademo account is TCP with a password, matching
// the published DSN. The final TCP ping proves the loopback listener — the
// address every driver dials — not just the socket.
const mysqlProvisionLines = [
  `if [ -f "$SERVICES_ROOT/mysql.pid" ]; then kill "$(cat "$SERVICES_ROOT/mysql.pid")" >/dev/null 2>&1 || true; fi`,
  'for attempt in $(seq 1 10); do [ -f "$SERVICES_ROOT/mysql.pid" ] && kill -0 "$(cat "$SERVICES_ROOT/mysql.pid")" >/dev/null 2>&1 || break; sleep 1; done',
  'rm -rf "$SERVICES_ROOT/mysql"',
  'mkdir -p "$SERVICES_ROOT/mysql"',
  'chown -R mysql "$SERVICES_ROOT/mysql"',
  'mariadb-install-db --datadir="$SERVICES_ROOT/mysql" --user=mysql --skip-test-db >/dev/null',
  `nohup /usr/sbin/mariadbd --user=mysql --datadir="$SERVICES_ROOT/mysql" --bind-address=127.0.0.1 --port=3306 --socket="$SERVICES_ROOT/mysql.sock" --pid-file="$SERVICES_ROOT/mysql.pid" >"$SERVICES_ROOT/mysql.log" 2>&1 &`,
  'for attempt in $(seq 1 30); do mysqladmin --socket="$SERVICES_ROOT/mysql.sock" -u root status >/dev/null 2>&1 && break; sleep 1; done',
  'mysqladmin --socket="$SERVICES_ROOT/mysql.sock" -u root status >/dev/null',
  `mariadb --socket="$SERVICES_ROOT/mysql.sock" -u root -e "CREATE DATABASE IF NOT EXISTS makeademo; CREATE USER IF NOT EXISTS 'makeademo'@'%' IDENTIFIED BY 'makeademo'; CREATE USER IF NOT EXISTS 'makeademo'@'localhost' IDENTIFIED BY 'makeademo'; GRANT ALL PRIVILEGES ON *.* TO 'makeademo'@'%'; GRANT ALL PRIVILEGES ON *.* TO 'makeademo'@'localhost'; FLUSH PRIVILEGES;"`,
  "mysqladmin --protocol=tcp --host=127.0.0.1 --port=3306 -u makeademo -pmakeademo ping >/dev/null",
  'echo "[makeademo:service] mysql ready at 127.0.0.1:3306"',
];

// Persistence stays off (--save "" --appendonly no): the reseed contract is
// that data lives exactly one provision cycle, so nothing may survive the
// reset through an RDB or AOF file.
const redisProvisionLines = [
  "redis-cli -h 127.0.0.1 -p 6379 shutdown nosave >/dev/null 2>&1 || true",
  'rm -rf "$SERVICES_ROOT/redis"',
  'mkdir -p "$SERVICES_ROOT/redis"',
  `redis-server --bind 127.0.0.1 --port 6379 --daemonize yes --dir "$SERVICES_ROOT/redis" --save "" --appendonly no --logfile "$SERVICES_ROOT/redis/redis.log"`,
  "for attempt in $(seq 1 30); do redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1 && break; sleep 1; done",
  "redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null",
  'echo "[makeademo:service] redis ready at 127.0.0.1:6379"',
];
