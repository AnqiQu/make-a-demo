import type { RepoSecurityInput } from "../../pipeline/02-repo-security-screen/repo-security-screen";
import type { PreparationWorkspaceProvider } from "../../pipeline/03-repo-preparation/preparation-workspace-runner";

export async function readRepoSecurityInput(
  provider: PreparationWorkspaceProvider,
  repoUrl: string,
): Promise<RepoSecurityInput> {
  const handle = await provider.create();

  try {
    process.stderr.write("[pipeline] daytona clone: started\n");
    await handle.workspace.setOutboundNetworkAccess(true);
    const cloneResult = await handle.workspace.execute(
      `mkdir -p /workspace && find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} + && git clone --depth 1 ${shellQuote(repoUrl)} /workspace`,
    );
    await handle.workspace.setOutboundNetworkAccess(false);
    if (cloneResult.exitCode !== 0) {
      throw new Error(
        `Daytona git clone failed: ${[cloneResult.stderr, cloneResult.stdout].filter((line) => line.length > 0).join("\n")}`,
      );
    }
    process.stderr.write("[pipeline] daytona clone: succeeded\n");

    const statsResult = await handle.workspace.execute(
      "find /workspace -path /workspace/.git -prune -o -path /workspace/node_modules -prune -o -type f -printf '%P\\t%s\\n'",
    );
    if (statsResult.exitCode !== 0) {
      throw new Error(`Daytona repo stats failed: ${statsResult.stderr}`);
    }

    const fileStats = statsResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [path = "", size = "0"] = line.split("\t");
        return { path, sizeBytes: Number(size) };
      });
    const files = await Promise.all(
      fileStats.map(async (file) => {
        if (!shouldReadForSecurity(file.path)) {
          return { path: file.path };
        }

        const textResult = await handle.workspace.execute(
          `cat ${shellQuote(`/workspace/${file.path}`)}`,
        );

        return {
          path: file.path,
          text: textResult.stdout,
        };
      }),
    );

    return {
      files,
      repoStats: {
        fileCount: fileStats.length,
        sizeBytes: fileStats.reduce((sum, file) => sum + file.sizeBytes, 0),
      },
    };
  } finally {
    await handle.destroy();
  }
}

function shouldReadForSecurity(path: string): boolean {
  return (
    path === "package.json" || path.startsWith(".env") || path.endsWith(".sh")
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
