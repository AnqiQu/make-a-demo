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
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type RepoSnapshotGit,
  assertRepoSourceArchiveIntegrity,
  readGithubRepoSnapshot,
} from "./repo-snapshot";

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
        await writeFile(input.archivePath, "sanitized execution archive");
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
        await writeFile(input.archivePath, "sanitized execution archive");
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
      path: join(runDirectory, "screened-repo.tar"),
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
