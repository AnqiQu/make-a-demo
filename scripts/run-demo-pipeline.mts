import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { runDefaultDemoPipeline } from "../src/server/agent-harness/default/default-demo-pipeline";
import { collectTerminalDemoInput } from "../src/server/agent-harness/terminal/terminal-demo-runner";
import { destroyAllDaytonaWorkspaces } from "../src/server/shared/integrations/daytona/daytona-sdk-preparation-workspace-provider";

// An interrupted run must not orphan its Daytona sandboxes; without this
// they keep billing until the server-side auto-delete backstop reaps them.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stdout.write(
      `${signal} received; deleting live Daytona sandboxes before exit...\n`,
    );
    void destroyAllDaytonaWorkspaces().finally(() => process.exit(130));
  });
}

const questioner = createInterface({ input: stdin, output: stdout });

try {
  const input = await collectTerminalDemoInput({
    question: (prompt) => questioner.question(prompt),
  });
  const result = await runDefaultDemoPipeline(input);

  stdout.write("\nMakeADemo terminal pipeline complete.\n");
  stdout.write(`Run directory: ${result.runDirectory}\n`);
  stdout.write(`Final video: ${result.finalVideoPath}\n`);
  stdout.write(`Demo Script: ${result.scriptPath}\n`);
  stdout.write(`Pipeline log: ${result.logPath}\n`);
  stdout.write(`Artifacts: ${result.artifactDirectory}\n`);
} finally {
  questioner.close();
}
