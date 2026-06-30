import { DaytonaSdkPreparationWorkspaceProvider } from "../src/server/shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";

const snapshot = process.env.MAKEADEMO_DAYTONA_SNAPSHOT;
const submittedCodeImage = process.env.MAKEADEMO_SUBMITTED_CODE_IMAGE;

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

console.log(`Creating Daytona workspace from snapshot ${snapshot}...`);
const provider = new DaytonaSdkPreparationWorkspaceProvider({
  snapshot,
  ...(submittedCodeImage === undefined || submittedCodeImage.trim().length === 0
    ? {}
    : { submittedCodeImage }),
});
const handle = await provider.create();

try {
  console.log(
    `Verifying preloaded submitted-code runtime image in ${handle.id}...`,
  );
  const runtime = await handle.workspace.executeSubmittedCode?.(
    [
      "node --version",
      "bun --version",
      "bunx tsc --version",
      "node -e \"require('@playwright/test'); console.log('playwright ok')\"",
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
  console.log(`Deleting Daytona workspace ${handle.id}...`);
  await handle.destroy();
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
