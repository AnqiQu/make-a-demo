import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type RepoSnapshotGit,
  assertRepoSourceArchiveIntegrity,
  defaultRepoSnapshotGit,
  readGithubRepoSnapshot,
} from "./repo-snapshot";

const run = promisify(execFile);

async function createRealGitCheckout(checkoutPath: string): Promise<void> {
  await mkdir(checkoutPath, { recursive: true });
  await writeFile(join(checkoutPath, "package.json"), "{}");
  await writeFile(
    join(checkoutPath, ".env"),
    "DATABASE_URL=postgres://production-secret\n",
  );
  await writeFile(join(checkoutPath, "index.ts"), "export const app = 1;\n");
  const git = (...args: string[]) =>
    run("git", [
      "-C",
      checkoutPath,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      ...args,
    ]);
  await git("init");
  await git("add", "-A");
  await git("commit", "-m", "seed");
}

describe("readGithubRepoSnapshot", () => {
  it("reads workspace declarations needed to classify nested packages", async () => {
    const runDirectory = join(
      tmpdir(),
      `makeademo-workspace-snapshot-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    const snapshot = await readGithubRepoSnapshot(
      {
        log: async () => undefined,
        repoUrl: "https://github.com/acme/workspace-app",
        runDirectory,
      },
      {
        git: {
          async archiveRevision(input) {
            await writeFile(input.archivePath, "workspace archive");
          },
          async clone(input) {
            await mkdir(input.checkoutPath, { recursive: true });
            await writeFile(join(input.checkoutPath, "package.json"), "{}");
            await symlink(
              "package.json",
              join(input.checkoutPath, "package-link.json"),
            );
            await writeFile(
              join(input.checkoutPath, "pnpm-workspace.yaml"),
              "packages:\n  - 'apps/*'\n",
            );
          },
          async readHead() {
            return "abc123def456";
          },
        },
      },
    );

    expect(
      snapshot.files.find(({ path }) => path === "pnpm-workspace.yaml")?.text,
    ).toContain("apps/*");
    expect(
      snapshot.files.find(({ path }) => path === "package-link.json"),
    ).toEqual({ path: "package-link.json", symlinkTarget: "package.json" });
  });

  it("reads compose files and prisma schemas for data-service detection", async () => {
    // N122: servicesRequired detection reads docker-compose services and the
    // Prisma datasource provider — those files must reach the profiler with
    // text, not as bare paths.
    const runDirectory = join(
      tmpdir(),
      `makeademo-services-snapshot-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    const snapshot = await readGithubRepoSnapshot(
      {
        log: async () => undefined,
        repoUrl: "https://github.com/acme/data-backed-app",
        runDirectory,
      },
      {
        git: {
          async archiveRevision(input) {
            await writeFile(input.archivePath, "data archive");
          },
          async clone(input) {
            await mkdir(join(input.checkoutPath, "prisma"), {
              recursive: true,
            });
            await writeFile(join(input.checkoutPath, "package.json"), "{}");
            await writeFile(
              join(input.checkoutPath, "docker-compose.yml"),
              "services:\n  db:\n    image: postgres:16\n",
            );
            await writeFile(
              join(input.checkoutPath, "prisma", "schema.prisma"),
              'datasource db {\n  provider = "postgresql"\n}\n',
            );
          },
          async readHead() {
            return "abc123def456";
          },
        },
      },
    );

    expect(
      snapshot.files.find(({ path }) => path === "docker-compose.yml")?.text,
    ).toContain("postgres:16");
    expect(
      snapshot.files.find(({ path }) => path === "prisma/schema.prisma")?.text,
    ).toContain('provider = "postgresql"');
  });

  it("kills a repository clone that hangs past its timeout", async () => {
    const server = createServer(() => {
      // Accept the connection and never respond, so the clone hangs.
    });
    await new Promise<void>((resolvePort) =>
      server.listen(0, "127.0.0.1", resolvePort),
    );
    const port = (server.address() as AddressInfo).port;
    try {
      const startedAt = Date.now();
      await expect(
        defaultRepoSnapshotGit.clone({
          checkoutPath: join(
            tmpdir(),
            `makeademo-hanging-clone-${crypto.randomUUID()}`,
          ),
          repoUrl: `http://127.0.0.1:${port}/acme/hanging.git`,
          timeoutMs: 750,
        }),
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      server.close();
    }
  });

  it("reads oversized package manifests and marks unreadable text files as unscanned", async () => {
    const runDirectory = join(
      tmpdir(),
      `makeademo-unscanned-snapshot-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    const oversizedScripts = JSON.stringify({
      description: "x".repeat(256 * 1024),
      scripts: { clean: "rm -rf /" },
    });
    const snapshot = await readGithubRepoSnapshot(
      {
        log: async () => undefined,
        repoUrl: "https://github.com/acme/oversized-app",
        runDirectory,
      },
      {
        git: {
          async archiveRevision(input) {
            await writeFile(input.archivePath, "oversized archive");
          },
          async clone(input) {
            await mkdir(input.checkoutPath, { recursive: true });
            await writeFile(
              join(input.checkoutPath, "package.json"),
              oversizedScripts,
            );
            await writeFile(
              join(input.checkoutPath, "NOTES.md"),
              `# notes\n${"y".repeat(256 * 1024)}`,
            );
          },
          async readHead() {
            return "abc123def456";
          },
        },
      },
    );

    const packageJson = snapshot.files.find(
      ({ path }) => path === "package.json",
    );
    expect(packageJson?.text).toContain("rm -rf /");
    const notes = snapshot.files.find(({ path }) => path === "NOTES.md");
    expect(notes).toEqual({ path: "NOTES.md", scanned: false });
  });

  it("keeps name-based quarantine in vendored directories while skipping their content inspection", async () => {
    const runDirectory = join(
      tmpdir(),
      `makeademo-vendored-snapshot-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    const snapshot = await readGithubRepoSnapshot(
      {
        log: async () => undefined,
        repoUrl: "https://github.com/acme/vendored-app",
        runDirectory,
      },
      {
        git: {
          async archiveRevision(input) {
            await writeFile(input.archivePath, gzipSync("vendored archive"));
          },
          async clone(input) {
            await mkdir(join(input.checkoutPath, "node_modules/pkg"), {
              recursive: true,
            });
            await mkdir(join(input.checkoutPath, "dist"), { recursive: true });
            await writeFile(join(input.checkoutPath, "package.json"), "{}");
            await writeFile(
              join(input.checkoutPath, "dist/.env.production"),
              "API_URL=https://prod.example\nSECRET_TOKEN=abc123\n",
            );
            await writeFile(
              join(input.checkoutPath, "node_modules/pkg/config.txt"),
              "API_KEY=sk_live_123\nDB_PASSWORD=hunter2\nSESSION_SECRET=s3cret\n",
            );
            await writeFile(
              join(input.checkoutPath, "node_modules/pkg/index.js"),
              "module.exports = 1;\n",
            );
          },
          async readHead() {
            return "abc123def456";
          },
        },
      },
    );

    const quarantined = snapshot.secretQuarantineManifest.entries.map(
      (entry) => entry.path,
    );
    expect(quarantined).toContain("dist/.env.production");
    expect(
      snapshot.secretQuarantineManifest.entries.find(
        (entry) => entry.path === "dist/.env.production",
      )?.environmentKeys,
    ).toEqual(["API_URL", "SECRET_TOKEN"]);
    expect(quarantined).not.toContain("node_modules/pkg/config.txt");
    expect(
      snapshot.files.find(({ path }) => path === "node_modules/pkg/index.js"),
    ).toEqual({ path: "node_modules/pkg/index.js" });
  });

  it("stops reading file contents once the cumulative scan budget is spent", async () => {
    const runDirectory = join(
      tmpdir(),
      `makeademo-budget-snapshot-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    const snapshot = await readGithubRepoSnapshot(
      {
        log: async () => undefined,
        repoUrl: "https://github.com/acme/budget-app",
        runDirectory,
      },
      {
        contentScanBudgetBytes: 10,
        git: {
          async archiveRevision(input) {
            await writeFile(input.archivePath, "budget archive");
          },
          async clone(input) {
            await mkdir(input.checkoutPath, { recursive: true });
            await writeFile(
              join(input.checkoutPath, "alpha.ts"),
              `export const alpha = "${"a".repeat(100)}";\n`,
            );
            await writeFile(
              join(input.checkoutPath, "beta.ts"),
              `export const beta = "${"b".repeat(100)}";\n`,
            );
          },
          async readHead() {
            return "abc123def456";
          },
        },
      },
    );

    expect(snapshot.files).toEqual(
      expect.arrayContaining([
        { path: "alpha.ts", scanned: false },
        { path: "beta.ts", scanned: false },
      ]),
    );
  });

  it("scans package manifests even after the cumulative scan budget is spent", async () => {
    const runDirectory = join(
      tmpdir(),
      `makeademo-manifest-budget-snapshot-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    const manifestText = '{"name":"app","scripts":{"start":"vite"}}\n';
    const projectManifestText =
      '{"name":"app","targets":{"start":{"executor":"@nx/vite:dev-server"}}}\n';
    const snapshot = await readGithubRepoSnapshot(
      {
        log: async () => undefined,
        repoUrl: "https://github.com/acme/budget-app",
        runDirectory,
      },
      {
        contentScanBudgetBytes: 10,
        git: {
          async archiveRevision(input) {
            await writeFile(input.archivePath, "budget archive");
          },
          async clone(input) {
            await mkdir(join(input.checkoutPath, "packages", "app"), {
              recursive: true,
            });
            await writeFile(
              join(input.checkoutPath, "alpha.ts"),
              `export const alpha = "${"a".repeat(100)}";\n`,
            );
            await writeFile(
              join(input.checkoutPath, "packages", "app", "package.json"),
              manifestText,
            );
            await writeFile(
              join(input.checkoutPath, "packages", "app", "project.json"),
              projectManifestText,
            );
          },
          async readHead() {
            return "abc123def456";
          },
        },
      },
    );

    expect(snapshot.files).toEqual(
      expect.arrayContaining([
        { path: "alpha.ts", scanned: false },
        { path: "packages/app/package.json", text: manifestText },
        { path: "packages/app/project.json", text: projectManifestText },
      ]),
    );
  });

  it("quarantines environment files and private keys from the execution archive without rejecting public certificates", async () => {
    const runDirectory = join(
      tmpdir(),
      `makeademo-secret-quarantine-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    let excludedPaths: string[] = [];
    const git: RepoSnapshotGit = {
      async archiveRevision(input) {
        excludedPaths = input.excludedPaths ?? [];
        await writeFile(
          input.archivePath,
          gzipSync("sanitized execution archive"),
        );
      },
      async clone(input) {
        await mkdir(join(input.checkoutPath, "certificates"), {
          recursive: true,
        });
        await mkdir(join(input.checkoutPath, "dist"), { recursive: true });
        await writeFile(join(input.checkoutPath, "package.json"), "{}");
        await writeFile(
          join(input.checkoutPath, ".env"),
          "DATABASE_URL=postgres://production-secret\nFEATURE_FLAG=true\n",
        );
        await writeFile(
          join(input.checkoutPath, ".env.example"),
          "DATABASE_URL=postgres://localhost/demo\n",
        );
        await writeFile(
          join(input.checkoutPath, "certificates", "public.pem"),
          "-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----\n",
        );
        await writeFile(
          join(input.checkoutPath, "certificates", "signing.pem"),
          "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n",
        );
        await writeFile(
          join(input.checkoutPath, "dist", ".env.production"),
          "DEPLOY_TOKEN=secret\n",
        );
        await writeFile(
          join(input.checkoutPath, "certificates", "credentials.conf"),
          "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----\n",
        );
      },
      async readHead() {
        return "abc123def456";
      },
    };

    const snapshot = await readGithubRepoSnapshot(
      {
        log: async () => undefined,
        repoUrl: "https://github.com/acme/quarantined-app",
        runDirectory,
      },
      { git },
    );

    expect(excludedPaths).toEqual([
      ".env",
      "certificates/credentials.conf",
      "certificates/signing.pem",
      "dist/.env.production",
    ]);
    expect(snapshot.secretQuarantineManifest).toEqual({
      entries: [
        {
          environmentKeys: ["DATABASE_URL", "FEATURE_FLAG"],
          kind: "environment-file",
          path: ".env",
        },
        {
          kind: "private-key-file",
          path: "certificates/credentials.conf",
        },
        {
          kind: "private-key-file",
          path: "certificates/signing.pem",
        },
        {
          environmentKeys: ["DEPLOY_TOKEN"],
          kind: "environment-file",
          path: "dist/.env.production",
        },
      ],
      version: "2026-07-15",
    });
    expect(
      snapshot.files.find((file) => file.path === ".env")?.text,
    ).toBeUndefined();
    expect(
      snapshot.files.find((file) => file.path === ".env.example")?.text,
    ).toContain("localhost");
    expect(excludedPaths).not.toContain("certificates/public.pem");
  });

  it("quarantines credential-shaped files beyond dotenv names", async () => {
    const runDirectory = join(
      tmpdir(),
      `makeademo-secret-predicates-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    let excludedPaths: string[] = [];
    const git: RepoSnapshotGit = {
      async archiveRevision(input) {
        excludedPaths = input.excludedPaths ?? [];
        await writeFile(
          input.archivePath,
          gzipSync("sanitized execution archive"),
        );
      },
      async clone(input) {
        await mkdir(join(input.checkoutPath, "config"), { recursive: true });
        await mkdir(join(input.checkoutPath, "packages", "app"), {
          recursive: true,
        });
        await mkdir(join(input.checkoutPath, "notes"), { recursive: true });
        await writeFile(join(input.checkoutPath, "package.json"), "{}");
        await writeFile(
          join(input.checkoutPath, ".envrc"),
          "export AWS_SECRET_ACCESS_KEY=abc123\n",
        );
        await writeFile(
          join(input.checkoutPath, "config", "prod.env"),
          "API_KEY=live-key\n",
        );
        await writeFile(
          join(input.checkoutPath, ".npmrc"),
          "//registry.npmjs.org/:_authToken=npm_secret\n",
        );
        await writeFile(
          join(input.checkoutPath, "packages", "app", ".npmrc"),
          "registry=https://registry.npmjs.org/\n",
        );
        await writeFile(
          join(input.checkoutPath, "config", "prod.tfvars"),
          'db_password = "hunter2"\n',
        );
        await writeFile(
          join(input.checkoutPath, "notes", "legacy-key.txt"),
          "PuTTY-User-Key-File-2: ssh-rsa\nPrivate-Lines: 14\n",
        );
        await writeFile(
          join(input.checkoutPath, "config", "secrets.txt"),
          "STRIPE_KEY=sk_live_abc\nDB_URL=postgres://prod\nSMTP_PASS=hunter2\n",
        );
        await writeFile(
          join(input.checkoutPath, "Makefile"),
          "CFLAGS=-O2\nbuild:\n\tmake all\n",
        );
        await writeFile(join(input.checkoutPath, "signing.p8"), "binary");
        await writeFile(
          join(input.checkoutPath, ".env.sample"),
          "API_KEY=replace-me\n",
        );
      },
      async readHead() {
        return "abc123def456";
      },
    };

    const snapshot = await readGithubRepoSnapshot(
      {
        log: async () => undefined,
        repoUrl: "https://github.com/acme/predicate-app",
        runDirectory,
      },
      { git },
    );

    expect(excludedPaths).toEqual([
      ".envrc",
      ".npmrc",
      "config/prod.env",
      "config/prod.tfvars",
      "config/secrets.txt",
      "notes/legacy-key.txt",
      "signing.p8",
    ]);
    expect(
      snapshot.secretQuarantineManifest.entries.find(
        (entry) => entry.path === "notes/legacy-key.txt",
      )?.kind,
    ).toBe("private-key-file");
    expect(
      snapshot.secretQuarantineManifest.entries.find(
        (entry) => entry.path === ".envrc",
      )?.environmentKeys,
    ).toEqual(["AWS_SECRET_ACCESS_KEY"]);
    expect(excludedPaths).not.toContain("packages/app/.npmrc");
    expect(excludedPaths).not.toContain("Makefile");
    expect(excludedPaths).not.toContain(".env.sample");
  });

  it("proves the real archive omits quarantined paths through the real git", async () => {
    const runDirectory = join(
      tmpdir(),
      `makeademo-real-archive-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    const git: RepoSnapshotGit = {
      archiveRevision: defaultRepoSnapshotGit.archiveRevision,
      async clone(input) {
        await createRealGitCheckout(input.checkoutPath);
      },
      readHead: defaultRepoSnapshotGit.readHead,
    };

    const snapshot = await readGithubRepoSnapshot(
      {
        log: async () => undefined,
        repoUrl: "https://github.com/acme/real-archive-app",
        runDirectory,
      },
      { git },
    );

    expect(snapshot.secretQuarantineManifest.entries).toEqual([
      expect.objectContaining({ kind: "environment-file", path: ".env" }),
    ]);
    const archive = gunzipSync(await readFile(snapshot.sourceArchive.path));
    expect(archive.includes("index.ts")).toBe(true);
    expect(archive.includes("production-secret")).toBe(false);
  });

  it("produces a gzip-compressed archive through the real git", async () => {
    // The screened archive crosses the network twice (developer uplink to the
    // sandbox); twenty's uncompressed 294MB tar could not finish inside the
    // upload attempt timeout on a contended uplink (2026-08-13T23-23 matrix).
    const runDirectory = join(
      tmpdir(),
      `makeademo-gzip-archive-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    const git: RepoSnapshotGit = {
      archiveRevision: defaultRepoSnapshotGit.archiveRevision,
      async clone(input) {
        await createRealGitCheckout(input.checkoutPath);
      },
      readHead: defaultRepoSnapshotGit.readHead,
    };

    const snapshot = await readGithubRepoSnapshot(
      {
        log: async () => undefined,
        repoUrl: "https://github.com/acme/gzip-archive-app",
        runDirectory,
      },
      { git },
    );

    expect(snapshot.sourceArchive.path.endsWith("screened-repo.tar.gz")).toBe(
      true,
    );
    const archive = await readFile(snapshot.sourceArchive.path);
    expect(archive[0]).toBe(0x1f);
    expect(archive[1]).toBe(0x8b);
  });

  it("rejects an archive that still contains a quarantined path", async () => {
    const runDirectory = join(
      tmpdir(),
      `makeademo-leaky-archive-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    const git: RepoSnapshotGit = {
      async archiveRevision(input) {
        await defaultRepoSnapshotGit.archiveRevision({
          archivePath: input.archivePath,
          checkoutPath: input.checkoutPath,
          commitSha: input.commitSha,
        });
      },
      async clone(input) {
        await createRealGitCheckout(input.checkoutPath);
      },
      readHead: defaultRepoSnapshotGit.readHead,
    };

    await expect(
      readGithubRepoSnapshot(
        {
          log: async () => undefined,
          repoUrl: "https://github.com/acme/leaky-archive-app",
          runDirectory,
        },
        { git },
      ),
    ).rejects.toThrow(/quarantined path/);
  });

  it("passes absolute checkout and archive paths to Git when the run directory is relative", async () => {
    await rm(".makeademo-test-runs", { force: true, recursive: true });
    const receivedPaths: string[] = [];
    const runDirectory = join(
      ".makeademo-test-runs",
      `relative-snapshot-${crypto.randomUUID()}`,
    );
    const git: RepoSnapshotGit = {
      async archiveRevision(input) {
        receivedPaths.push(input.archivePath, input.checkoutPath);
        await writeFile(input.archivePath, "relative archive");
      },
      async clone(input) {
        receivedPaths.push(input.checkoutPath);
        await mkdir(input.checkoutPath, { recursive: true });
        await writeFile(join(input.checkoutPath, "package.json"), "{}");
      },
      async readHead(checkoutPath) {
        receivedPaths.push(checkoutPath);
        return "abc123def456";
      },
    };

    const snapshot = await readGithubRepoSnapshot(
      {
        log: async () => undefined,
        repoUrl: "https://github.com/acme/relative-app",
        runDirectory,
      },
      { git },
    );

    expect(receivedPaths.every(isAbsolute)).toBe(true);
    expect(isAbsolute(snapshot.sourceArchive.path)).toBe(true);
    await rm(runDirectory, { force: true, recursive: true });
  });

  it("returns an immutable archive of the exact revision used for screening", async () => {
    const runDirectory = join(
      tmpdir(),
      `makeademo-repo-snapshot-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    const archivedRevisions: string[] = [];
    const archiveContents = "archive of screened revision";
    const git: RepoSnapshotGit = {
      async archiveRevision(input) {
        archivedRevisions.push(input.commitSha);
        await writeFile(input.archivePath, archiveContents);
      },
      async clone(input) {
        await mkdir(input.checkoutPath, { recursive: true });
        await writeFile(
          join(input.checkoutPath, "package.json"),
          JSON.stringify({ name: "screened-app" }),
        );
      },
      async readHead() {
        return "abc123def456";
      },
    };

    const snapshot = await readGithubRepoSnapshot(
      {
        log: async () => undefined,
        repoUrl: "https://github.com/acme/screened-app",
        runDirectory,
      },
      { git },
    );

    expect(snapshot.commitSha).toBe("abc123def456");
    expect(archivedRevisions).toEqual(["abc123def456"]);
    expect(snapshot.sourceArchive).toEqual({
      commitSha: "abc123def456",
      path: join(runDirectory, "screened-repo.tar.gz"),
      sha256: createHash("sha256").update(archiveContents).digest("hex"),
    });
    await expect(readFile(snapshot.sourceArchive.path, "utf8")).resolves.toBe(
      archiveContents,
    );
    await expect(stat(join(runDirectory, "repo-snapshot"))).rejects.toThrow();
    expect(snapshot.files).toEqual([
      { path: "package.json", text: JSON.stringify({ name: "screened-app" }) },
    ]);
  });

  it("uses a short-lived installation credential for a private clone without logging it", async () => {
    const runDirectory = join(
      tmpdir(),
      `makeademo-private-snapshot-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    const logs: unknown[] = [];
    const cloneCredentials: unknown[] = [];
    const installationIds: string[] = [];
    const token = "github-installation-secret";
    const git: RepoSnapshotGit = {
      async archiveRevision(input) {
        await writeFile(input.archivePath, "private archive");
      },
      async clone(input) {
        cloneCredentials.push(input.credential);
        await mkdir(input.checkoutPath, { recursive: true });
        await writeFile(join(input.checkoutPath, "package.json"), "{}");
      },
      async readHead() {
        return "def456abc123";
      },
    };

    await readGithubRepoSnapshot(
      {
        githubInstallationId: "installation-123",
        log: async (event, fields) => {
          logs.push({ event, fields });
        },
        repoUrl: "https://github.com/acme/private-app",
        runDirectory,
      },
      {
        git,
        installationTokenProvider: {
          async createInstallationToken(installationId) {
            installationIds.push(installationId);
            return token;
          },
        },
      },
    );

    expect(installationIds).toEqual(["installation-123"]);
    expect(cloneCredentials).toEqual([
      { password: token, username: "x-access-token" },
    ]);
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it("rejects a screened source archive changed before repository preparation", async () => {
    const runDirectory = join(
      tmpdir(),
      `makeademo-mutated-snapshot-${crypto.randomUUID()}`,
    );
    await mkdir(runDirectory, { recursive: true });
    const snapshot = await readGithubRepoSnapshot(
      {
        log: async () => undefined,
        repoUrl: "https://github.com/acme/screened-app",
        runDirectory,
      },
      {
        git: {
          async archiveRevision(input) {
            await writeFile(input.archivePath, "screened archive");
          },
          async clone(input) {
            await mkdir(input.checkoutPath, { recursive: true });
            await writeFile(join(input.checkoutPath, "package.json"), "{}");
          },
          async readHead() {
            return "123abc456def";
          },
        },
      },
    );
    await appendFile(snapshot.sourceArchive.path, "mutated");

    await expect(
      assertRepoSourceArchiveIntegrity(snapshot.sourceArchive),
    ).rejects.toThrow("Screened repository archive integrity check failed");
  });
});
