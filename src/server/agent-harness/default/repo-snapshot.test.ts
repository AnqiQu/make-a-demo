import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
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
