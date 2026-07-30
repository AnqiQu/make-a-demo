import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { exploreSubmittedApp } from "./submitted-app-explorer";

const execFileAsync = promisify(execFile);

// A client-rendered page that serves a quiet, empty skeleton and injects its
// real content after the explorer's DOM-settle window: no headings, no main
// text, a same-route nav link, a labelled input, and a data table.
const deferredContentPage = `<!doctype html><html><head><title>Deferred App</title></head><body>
<div id="root"></div>
<script>
setTimeout(() => {
  document.getElementById("root").innerHTML =
    '<nav><a href="/">Ledger entries</a></nav>' +
    '<input placeholder="Search entries" />' +
    '<div><table><tbody><tr><td>Office chairs</td><td>-120.00</td></tr></tbody></table></div>';
}, 1200);
</script>
</body></html>`;

async function buildExplorerScript(baseUrl: string): Promise<string> {
  const commands: string[] = [];
  await exploreSubmittedApp({
    baseUrl,
    preparationManifestId: "prep_script_test",
    workspace: {
      async destroy() {},
      async execute() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      async executeSubmittedCode(command: string) {
        commands.push(command);
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            '\n[makeademo:exploration] {"blockedNetworkAttempts":[],"consoleErrors":[],"pageErrors":[],"routes":[],"unreachableRoutes":[]}\n',
        };
      },
    },
  });
  const encoded = /printf %s '([^']+)'/.exec(
    commands.find((command) => command.includes("explore-app.mjs")) ?? "",
  )?.[1];
  expect(encoded).toBeDefined();
  return Buffer.from(encoded ?? "", "base64").toString("utf8");
}

describe("generated exploration script", () => {
  it("observes content that streams in after the initial DOM settles", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(deferredContentPage);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a port");
    }
    try {
      const outputDirectory = await mkdtemp(
        join(tmpdir(), "makeademo-explorer-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);

      // Run exactly as the sandbox does: bun, with the script outside any
      // node_modules walk-up so NODE_PATH supplies the pinned playwright.
      const { stdout } = await execFileAsync("bun", [scriptPath], {
        env: {
          ...process.env,
          NODE_PATH: join(process.cwd(), "node_modules"),
        },
        timeout: 25_000,
      });
      const marker = stdout.split("[makeademo:exploration] ")[1];
      expect(marker).toBeDefined();
      const result = JSON.parse((marker ?? "").trim()) as {
        fatalError?: string;
        routes: Array<{
          interactions: Array<{ kind: string; name: string }>;
          text: string[];
          textLocatorEvidence: Array<object | null>;
        }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.routes).toHaveLength(1);
      const route = result.routes[0];
      expect(route?.text.join(" ")).toContain("Ledger entries");
      expect(route?.textLocatorEvidence.filter(Boolean).length).toBeGreaterThan(
        0,
      );
      expect(route?.interactions).toContainEqual(
        expect.objectContaining({ kind: "fill", name: "Search entries" }),
      );
    } finally {
      server.close();
    }
  }, 30_000);
});
