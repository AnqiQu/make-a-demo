import { describe, expect, it } from "vitest";

import {
  createServiceProvisionCommand,
  provisionableServices,
  readProvisionedServicePlans,
  sandboxServiceConnectionUrls,
} from "./sandbox-services";

describe("sandbox services", () => {
  it("plans only provisioned-service declarations with their commands", () => {
    const plans = readProvisionedServicePlans([
      {
        detail: "harness Postgres on loopback",
        migrationCommand: "npx prisma migrate deploy",
        rung: "provisioned-service",
        seedCommand: "npx prisma db seed",
        service: "Postgres",
      },
      {
        detail: "cache served from in-code fixtures",
        rung: "declared-stub",
        service: "redis",
      },
    ]);

    expect(plans).toEqual([
      {
        migrationCommand: "npx prisma migrate deploy",
        seedCommand: "npx prisma db seed",
        service: "postgres",
      },
    ]);
  });

  it("returns no plans for a manifest without data strategy declarations", () => {
    expect(readProvisionedServicePlans(undefined)).toEqual([]);
  });

  it("rejects provisioned-service declarations the sandbox cannot boot", () => {
    expect(() =>
      readProvisionedServicePlans([
        {
          detail: "documents served from a real mongo",
          rung: "provisioned-service",
          service: "mongodb",
        },
      ]),
    ).toThrow(/mongodb.*mysql, postgres, redis/s);
  });

  it("publishes loopback-only connection urls that match the boot commands", () => {
    for (const service of provisionableServices) {
      const url = sandboxServiceConnectionUrls[service];
      expect(url).toContain("127.0.0.1");
      const port = /:(\d+)/.exec(url.split("@").at(-1) ?? "")?.[1];
      expect(port).toBeDefined();
      const command = createServiceProvisionCommand(service);
      expect(command).toContain(`${port}`);
      expect(command).not.toContain("0.0.0.0");
    }
  });

  it("boots postgres from a reset data directory and proves readiness", () => {
    const command = createServiceProvisionCommand("postgres");

    expect(command).toContain("initdb");
    expect(command).toContain("rm -rf");
    expect(command).toContain("pg_isready");
    expect(command).toContain("127.0.0.1");
    expect(command).toContain("makeademo");
    expect(command).toContain("[makeademo:service] postgres ready");
  });

  it("boots mysql through mariadb from a reset data directory", () => {
    const command = createServiceProvisionCommand("mysql");

    expect(command).toContain("mariadb-install-db");
    expect(command).toContain("rm -rf");
    expect(command).toContain("mysqladmin");
    expect(command).toContain("127.0.0.1");
    expect(command).toContain("[makeademo:service] mysql ready");
  });

  it("boots redis bound to loopback with persistence disabled", () => {
    const command = createServiceProvisionCommand("redis");

    expect(command).toContain("redis-server");
    expect(command).toContain("--bind 127.0.0.1");
    expect(command).toContain("redis-cli");
    expect(command).toContain("[makeademo:service] redis ready");
  });
});
