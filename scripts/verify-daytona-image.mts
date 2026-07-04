import { DaytonaSdkPreparationWorkspaceProvider } from "../src/server/shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";

const snapshot = process.env.MAKEADEMO_DAYTONA_SNAPSHOT;
const submittedCodeSnapshot =
  process.env.MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT;

if (process.env.DAYTONA_API_KEY === undefined) {
  throw new Error(
    "DAYTONA_API_KEY is required to verify the prepared Daytona image.",
  );
}

if (snapshot === undefined || snapshot.trim().length === 0) {
  throw new Error(
    "MAKEADEMO_DAYTONA_SNAPSHOT is required to verify the prepared Daytona image.",
  );
}

if (
  submittedCodeSnapshot === undefined ||
  submittedCodeSnapshot.trim().length === 0
) {
  throw new Error(
    "MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT is required to verify the prepared submitted-code Daytona image.",
  );
}

console.log(`Creating Daytona workspace from snapshot ${snapshot}...`);
const provider = new DaytonaSdkPreparationWorkspaceProvider({
  snapshot,
  submittedCodeSnapshot,
});
const handle = await provider.create();
let submittedCodeNetworkOpened = false;

try {
  console.log(`Verifying parent Git/CA trust in ${handle.id}...`);
  const parentGitTrust = await handle.workspace.execute(
    [
      "git --version",
      "git ls-remote https://github.com/octocat/Hello-World.git HEAD",
    ].join(" && "),
    {
      onStderr: (chunk) => process.stderr.write(chunk),
      onStdout: (chunk) => process.stdout.write(chunk),
    },
  );
  assertCommandSucceeded("parent Git/CA trust", parentGitTrust);

  console.log(
    `Verifying preloaded submitted-code runtime image in ${handle.id}...`,
  );
  if (handle.workspace.setSubmittedCodeNetworkAccess !== undefined) {
    await handle.workspace.setSubmittedCodeNetworkAccess(true);
    submittedCodeNetworkOpened = true;
  }
  const runtime = await handle.workspace.executeSubmittedCode?.(
    [
      "node --version",
      "bun --version",
      "bunx tsc --version",
      "git --version",
      "git ls-remote https://github.com/octocat/Hello-World.git HEAD",
      [
        'NODE_PATH="$(npm root -g)"',
        "node -e \"require('@playwright/test'); console.log('playwright ok')\"",
      ].join(" "),
    ].join(" && "),
    {
      onStderr: (chunk) => process.stderr.write(chunk),
      onStdout: (chunk) => process.stdout.write(chunk),
    },
  );
  if (runtime === undefined) {
    throw new Error(
      "Prepared Daytona workspace lacks submitted-code execution.",
    );
  }
  assertCommandSucceeded("submitted-code runtime", runtime);
  if (!runtime.stdout.includes("playwright ok")) {
    throw new Error("Submitted-code runtime did not load @playwright/test.");
  }

  console.log("Prepared Daytona image verification passed.");
} finally {
  try {
    if (
      submittedCodeNetworkOpened &&
      handle.workspace.setSubmittedCodeNetworkAccess !== undefined
    ) {
      await handle.workspace.setSubmittedCodeNetworkAccess(false);
    }
  } finally {
    console.log(`Deleting Daytona workspace ${handle.id}...`);
    await handle.destroy();
  }
}

function assertCommandSucceeded(
  label: string,
  result: { exitCode: number; stderr: string; stdout: string },
): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${result.exitCode}: ${[
        result.stderr,
        result.stdout,
      ]
        .filter((output) => output.length > 0)
        .join("\n")}`,
    );
  }
}
