import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createFakeAgentHarnessWorkspace } from "../daytona/workspace.test-helpers";
import type { PreparedDemoFeature } from "../schemas/artifacts";
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

async function buildExplorerScript(
  baseUrl: string,
  featureInventory?: PreparedDemoFeature[],
  scope?: "feature-entries",
  captureFailure?: Parameters<typeof exploreSubmittedApp>[0]["captureFailure"],
): Promise<string> {
  const commands: string[] = [];
  await exploreSubmittedApp({
    baseUrl,
    ...(captureFailure === undefined ? {} : { captureFailure }),
    ...(featureInventory === undefined ? {} : { featureInventory }),
    preparationManifestId: "prep_script_test",
    ...(scope === undefined ? {} : { scope }),
    workspace: createFakeAgentHarnessWorkspace({
      async executeSubmittedCode(command: string) {
        commands.push(command);
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            '\n[makeademo:exploration] {"blockedNetworkAttempts":[],"consoleErrors":[],"pageErrors":[],"routes":[],"unreachableRoutes":[]}\n',
        };
      },
    }),
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
          path?: string;
          text: string[];
          textLocatorEvidence: Array<object | null>;
        }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(
        result.routes.filter(
          (route: { path?: string }) =>
            !(route.path ?? "").includes("__makeademo-404-probe__"),
        ),
      ).toHaveLength(1);
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

  it("records a click's same-origin navigation destination as structured evidence", async () => {
    const navigationPage = `<!doctype html><html><head><title>Calendar</title></head><body>
<h1>Calendar</h1>
<button onclick="history.pushState({}, '', '/auth/login'); document.querySelector('h1').textContent = 'Login'">New</button>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(navigationPage);
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

      const { stdout } = await execFileAsync("bun", [scriptPath], {
        env: {
          ...process.env,
          NODE_PATH: join(process.cwd(), "node_modules"),
        },
        timeout: 30_000,
      });
      const marker = stdout.split("[makeademo:exploration] ")[1];
      expect(marker).toBeDefined();
      const result = JSON.parse((marker ?? "").trim()) as {
        routes: Array<{
          interactions: Array<{
            name: string;
            navigationDestination?: string;
          }>;
        }>;
      };

      expect(result.routes[0]?.interactions).toContainEqual(
        expect.objectContaining({
          name: "New",
          navigationDestination: "/auth/login",
        }),
      );
    } finally {
      server.close();
    }
  }, 35_000);

  it("records control renames and disabled-to-enabled transitions as interaction outcomes", async () => {
    // N105: a toggle that renames itself (Follow → Unfollow) and a click
    // that enables a disabled control (Save draft → Undo enabled) are
    // wording-free proof of behavior; both previously produced no visible
    // delta the outcome describer could see, so the interactions were
    // silently discarded.
    const togglePage = `<!doctype html><html><head><title>Toggle App</title></head><body>
<h1>Project workspace</h1>
<main><p>Quarterly planning workspace for the demo team</p></main>
<button onclick="this.textContent='Unfollow'">Follow</button>
<button onclick="document.getElementById('undo').disabled = false">Save draft</button>
<button id="undo" disabled>Undo</button>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(togglePage);
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

      const { stdout } = await execFileAsync("bun", [scriptPath], {
        env: {
          ...process.env,
          NODE_PATH: join(process.cwd(), "node_modules"),
        },
        timeout: 60_000,
      });
      const marker = stdout.split("[makeademo:exploration] ")[1];
      expect(marker).toBeDefined();
      const result = JSON.parse((marker ?? "").trim()) as {
        fatalError?: string;
        routes: Array<{
          buttons: string[];
          interactions: Array<{
            name: string;
            outcome: string;
            stateTransition?: { control: string; from: string; to: string };
          }>;
        }>;
      };

      expect(result.fatalError).toBeUndefined();
      const route = result.routes[0];
      expect(route?.buttons).toContain("Undo");
      expect(route?.interactions).toContainEqual(
        expect.objectContaining({
          name: "Follow",
          outcome: "Follow became Unfollow",
          stateTransition: {
            control: "Follow",
            from: "Follow",
            to: "Unfollow",
          },
        }),
      );
      expect(route?.interactions).toContainEqual(
        expect.objectContaining({
          name: "Save draft",
          outcome: "Undo [disabled] → [enabled]",
          stateTransition: { control: "Undo", from: "disabled", to: "enabled" },
        }),
      );
      // The disabled control itself is never clicked.
      expect(route?.interactions).not.toContainEqual(
        expect.objectContaining({ name: "Undo" }),
      );
    } finally {
      server.close();
    }
  }, 60_000);

  it("quarantines alert text from the content harvest into a separate alerts field", async () => {
    // Error toasts are what an app shows when it fails; harvested as text
    // they ground features on failure copy (outline, 2026-08-08).
    const toastPage = `<!doctype html><html><head><title>Docs App</title></head><body>
<h1>Team wiki</h1>
<main><p>Quarterly planning notes</p></main>
<div role="alert">Could not load shared documents<button>Close toast</button></div>
<div aria-live="polite">Saving draft…</div>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(toastPage);
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
        routes: Array<{
          alerts?: string[];
          buttons: string[];
          headings: string[];
          text: string[];
        }>;
      };

      const route = result.routes[0];
      expect(route?.alerts?.join(" ")).toContain(
        "Could not load shared documents",
      );
      expect(route?.alerts?.join(" ")).toContain("Saving draft…");
      expect(route?.headings).toEqual(["Team wiki"]);
      expect(route?.text.join(" ")).toContain("Quarterly planning notes");
      expect(route?.text.join(" ")).not.toContain("Could not load");
      expect(route?.buttons).not.toContain("Close toast");
    } finally {
      server.close();
    }
  }, 30_000);

  it("reloads once and re-harvests when a module fetch 504s", async () => {
    // Vite answers module requests with HTTP 504 ("Outdated Optimize Dep")
    // while its dependency optimizer re-bundles; the route renders its empty
    // shell until one reload fetches the fresh module (directus, 2026-08-08).
    const staleDepPage = `<!doctype html><html><head><title>Stale Dep App</title></head><body>
<nav><a href="/">Ledger home</a></nav>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body></html>`;
    let moduleRequests = 0;
    const server = createServer((request, response) => {
      if ((request.url ?? "/").startsWith("/app.js")) {
        moduleRequests += 1;
        if (moduleRequests === 1) {
          response.writeHead(504, { "content-type": "text/plain" });
          response.end("Outdated Optimize Dep");
          return;
        }
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(
          'document.getElementById("root").innerHTML = "<h1>Recovered ledger</h1><main><p>Quarterly invoice totals by customer</p></main>";',
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(staleDepPage);
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
        routes: Array<{ headings: string[]; path?: string; text: string[] }>;
      };

      const route = result.routes.find(
        (candidate) =>
          !(candidate.path ?? "").includes("__makeademo-404-probe__"),
      );
      expect(route?.headings).toContain("Recovered ledger");
      expect(route?.text.join(" ")).toContain(
        "Quarterly invoice totals by customer",
      );
    } finally {
      server.close();
    }
  }, 30_000);

  it("records the app's not-found page as a probe route and drops it on redirect", async () => {
    const contentFor = (path: string) =>
      path === "/"
        ? "<h1>Team wiki</h1><main><p>Quarterly planning notes</p></main>"
        : "<h1>Not found</h1><main><p>The page cannot be found.</p></main>";
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><title>Docs App</title></head><body>${contentFor(request.url ?? "/")}</body></html>`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a port");
    }
    const redirectServer = createServer((request, response) => {
      if ((request.url ?? "/") !== "/") {
        response.writeHead(302, { location: "/" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Docs App</title></head><body><h1>Team wiki</h1></body></html>",
      );
    });
    await new Promise<void>((resolve) =>
      redirectServer.listen(0, "127.0.0.1", resolve),
    );
    const redirectAddress = redirectServer.address();
    if (redirectAddress === null || typeof redirectAddress === "string") {
      throw new Error("redirect test server did not expose a port");
    }
    try {
      const run = async (port: number) => {
        const outputDirectory = await mkdtemp(
          join(tmpdir(), "makeademo-explorer-"),
        );
        const script = (
          await buildExplorerScript(`http://127.0.0.1:${port}`)
        ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
        const scriptPath = join(outputDirectory, "explore-app.mjs");
        await writeFile(scriptPath, script);
        const { stdout } = await execFileAsync("bun", [scriptPath], {
          env: {
            ...process.env,
            NODE_PATH: join(process.cwd(), "node_modules"),
          },
          timeout: 25_000,
        });
        const marker = stdout.split("[makeademo:exploration] ")[1];
        expect(marker).toBeDefined();
        return JSON.parse((marker ?? "").trim()) as {
          routes: Array<{ headings: string[]; path: string }>;
        };
      };

      const withNotFound = await run(address.port);
      const probeRoute = withNotFound.routes.find((route) =>
        route.path.includes("__makeademo-404-probe__"),
      );
      expect(probeRoute?.headings).toContain("Not found");

      const redirected = await run(redirectAddress.port);
      expect(
        redirected.routes.some((route) =>
          route.path.includes("__makeademo-404-probe__"),
        ),
      ).toBe(false);
    } finally {
      server.close();
      redirectServer.close();
    }
  }, 60_000);

  it("flags a route that never leaves its full-page loading overlay", async () => {
    // cyberchef (2026-08-08 matrix): a full-viewport loader that never
    // clears, with the real UI parked behind it — no errors, no blocked
    // requests, just a page that is not ready and never becomes ready.
    const stuckLoaderPage = `<!doctype html><html><head><title>Stuck App</title>
<style>#loading-overlay{position:fixed;inset:0;background:#eee;z-index:10;display:flex;align-items:center;justify-content:center}</style>
</head><body>
<div id="loading-overlay"><p>Issuing one-time pads and warming caches...</p></div>
<main><h1>Operations</h1><button>To Base64</button><button>Bake!</button></main>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(stuckLoaderPage);
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
        join(tmpdir(), "makeademo-explorer-stuck-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
      const { stdout } = await execFileAsync("bun", [scriptPath], {
        env: {
          ...process.env,
          NODE_PATH: join(process.cwd(), "node_modules"),
        },
        timeout: 45_000,
      });
      const marker = stdout.split("[makeademo:exploration] ")[1];
      expect(marker).toBeDefined();
      const result = JSON.parse((marker ?? "").trim()) as {
        fatalError?: string;
        routes: Array<{ loadingOverlay?: boolean }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.routes[0]?.loadingOverlay).toBe(true);
    } finally {
      server.close();
    }
  }, 60_000);

  it("waits out a clearing loading overlay and harvests the revealed page", async () => {
    const clearingLoaderPage = `<!doctype html><html><head><title>Slow App</title>
<style>#boot-spinner{position:fixed;inset:0;background:#fff;z-index:10}</style>
</head><body>
<div id="boot-spinner">Loading workspace...</div>
<main><h1>Ledger</h1><p>Quarterly totals ready for review.</p></main>
<script>setTimeout(() => document.getElementById("boot-spinner").remove(), 1500);</script>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(clearingLoaderPage);
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
        join(tmpdir(), "makeademo-explorer-clearing-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        routes: Array<{ loadingOverlay?: boolean; text: string[] }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.routes[0]?.loadingOverlay).toBe(false);
      expect(result.routes[0]?.text.join(" ")).toContain("Quarterly totals");
    } finally {
      server.close();
    }
  }, 30_000);

  it("harvests text revealed by an exercised interaction with verified locators", async () => {
    // Tool-shaped UIs (cyberchef's Magic search) reveal their proof-text
    // only after an interaction: the static harvest can never catalog an
    // assert for them, so exploration must capture what newly appeared.
    const toolPage = `<!doctype html><html><head><title>Analyzer</title></head><body>
<nav><a href="/">Analyzer home</a></nav>
<main><div id="result"></div></main>
<button onclick="document.getElementById('result').innerHTML='<p>Detected format: Base64</p>'">Run analysis</button>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(toolPage);
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
        join(tmpdir(), "makeademo-explorer-revealed-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
          interactions?: Array<{
            name: string;
            revealedTexts?: Array<{
              locatorEvidence: object | null;
              value: string;
            }>;
          }>;
          text: string[];
        }>;
      };

      expect(result.fatalError).toBeUndefined();
      const interaction = result.routes[0]?.interactions?.find(
        (candidate) => candidate.name === "Run analysis",
      );
      const revealed = interaction?.revealedTexts?.find(
        (candidate) => candidate.value === "Detected format: Base64",
      );
      expect(revealed).toBeDefined();
      expect(revealed?.locatorEvidence).not.toBeNull();
      // The revealed text exists only post-interaction: it must not leak
      // into the static route harvest that seeds ordinary asserts.
      expect(result.routes[0]?.text).not.toContain("Detected format: Base64");
    } finally {
      server.close();
    }
  }, 30_000);

  it("harvests table content on a route whose selector text is only its own navigation", async () => {
    // The sidebar renders as main li entries, so the primary text harvest is
    // non-empty but carries only nav names; the data rows live in a table the
    // paragraph/list selectors never reach.
    const sidebarTablePage = `<!doctype html><html><head><title>Sidebar App</title></head><body>
<main>
<nav><ul><li><a href="/">Invoices</a></li><li><a href="/">Settings</a></li></ul></nav>
<table><tbody><tr><td>Aperture Labs</td><td>4,200.00</td></tr></tbody></table>
</main>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(sidebarTablePage);
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
        join(tmpdir(), "makeademo-explorer-table-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        routes: Array<{ text: string[] }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.routes[0]?.text.join(" ")).toContain("Aperture Labs");
    } finally {
      server.close();
    }
  }, 30_000);

  it("harvests accessibility-tree text when the selector harvest is thin", async () => {
    // Control-centric tools render their substance in controls and unlabeled
    // containers: one non-nav list string must not suppress the aria harvest
    // that supplies the pane titles feature grounding needs.
    const controlPanelPage = `<!doctype html><html><head><title>Tool App</title></head><body>
<main>
<nav><ul><li><a href="/">Docs</a></li></ul></nav>
<ul><li><button>To Base64</button></li></ul>
<div>Operations catalog</div>
<input placeholder="Search..." />
<div>Recipe</div>
<button>Bake</button>
<div>Auto Bake Input</div>
</main>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(controlPanelPage);
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
        join(tmpdir(), "makeademo-explorer-aria-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        routes: Array<{ text: string[] }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.routes[0]?.text).toEqual(
        expect.arrayContaining(["Recipe", "Auto Bake Input"]),
      );
    } finally {
      server.close();
    }
  }, 30_000);

  it("harvests accessibility-tree text even when the selector harvest is rich", async () => {
    // A dashboard's headline metric often renders in a bare div the
    // paragraph/list selectors never reach. A rich selector harvest must not
    // suppress the aria harvest, or exactly the string a feature needs for
    // grounding goes unseen while filler paragraphs fill the report.
    const richDashboardPage = `<!doctype html><html><head><title>Fleet App</title></head><body>
<h1>Fleet dashboard</h1><h2>Vehicles</h2><h3>Maintenance</h3>
<main>
<p>Seven vehicles are currently active</p>
<p>Two vehicles are charging at depot four</p>
<p>One vehicle needs a tire rotation</p>
<p>Route coverage is nominal today</p>
<p>Depot four reports full capacity</p>
</main>
<div>Total balance $12,400</div>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(richDashboardPage);
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
        join(tmpdir(), "makeademo-explorer-aria-rich-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        routes: Array<{ text: string[] }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.routes[0]?.text).toContain("Total balance $12,400");
    } finally {
      server.close();
    }
  }, 30_000);

  it("keeps a feature-named control inside the harvest budget on a control-dense page", async () => {
    // Seventeen filler buttons precede the one control the prepared feature
    // is about. A positional cut would drop it; the budget must spend its
    // slots on feature-matching accessible names first.
    const fillers = Array.from(
      { length: 17 },
      (_, index) => `<button>Filler action ${index + 1}</button>`,
    ).join("\n");
    const controlDensePage = `<!doctype html><html><head><title>Dense App</title></head><body>
<main>
${fillers}
<button>Export report</button>
</main>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(controlDensePage);
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
        join(tmpdir(), "makeademo-explorer-controls-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`, [
          {
            authStrategy: "none",
            description: "Export the monthly report.",
            entryPaths: ["/"],
            fixtureNotes: [],
            id: "export-report",
            label: "Export report",
            sourcePaths: ["src/export.ts"],
          },
        ])
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        routes: Array<{ buttons: string[] }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.routes[0]?.buttons).toContain("Export report");
      expect(result.routes[0]?.buttons.length).toBeLessThanOrEqual(16);
    } finally {
      server.close();
    }
  }, 30_000);

  it("records the document status and a body sample for an error response", async () => {
    // A route answering 500 with a bare stack-trace body: the status and a
    // bounded innerText sample must reach the observation so the backend
    // can classify the route as a runtime fault instead of a wording gap.
    const brokenPage = `<!doctype html><html><head><title>Broken</title></head><body><pre>TypeError: Cannot read properties of undefined (reading 'map')
    at ReportList.render (/app/src/reports.tsx:12:5)</pre></body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      response.end(brokenPage);
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
        join(tmpdir(), "makeademo-explorer-status-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        routes: Array<{ documentStatus?: number; textSample?: string }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.routes[0]?.documentStatus).toBe(500);
      expect(result.routes[0]?.textSample).toContain("TypeError");
    } finally {
      server.close();
    }
  }, 30_000);

  it("executes declared proofs and records pass and fail outcomes", async () => {
    // N107: two declared proofs against a live page — a visible-text proof
    // that holds and a state-transition proof whose control never renames.
    // Both verdicts must reach the observation with honest details.
    const proofPage = `<!doctype html><html><head><title>Proof App</title></head><body>
<main>
<h1>Editor</h1>
<p>Published demo article</p>
<button onclick="this.textContent='Unfollow'">Follow</button>
<button>Stubborn</button>
</main>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(proofPage);
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
        join(tmpdir(), "makeademo-explorer-proofs-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`, [
          {
            authStrategy: "none",
            description: "Publish a demo article.",
            entryPaths: ["/"],
            expectedProof: {
              kind: "visible-text",
              text: "Published demo article",
            },
            fixtureNotes: [],
            id: "post-article",
            label: "Posting an article",
            sourcePaths: ["src/editor.tsx"],
          },
          {
            authStrategy: "none",
            description: "Follow an author.",
            entryPaths: ["/"],
            expectedProof: {
              from: "Follow",
              kind: "state-transition",
              locator: "Follow",
              to: "Unfollow",
            },
            fixtureNotes: [],
            id: "follow-author",
            label: "Following an author",
            sourcePaths: ["src/profile.tsx"],
          },
          {
            authStrategy: "none",
            description: "Rename the stubborn control.",
            entryPaths: ["/"],
            expectedProof: {
              from: "Stubborn",
              kind: "state-transition",
              locator: "Stubborn",
              to: "Convinced",
            },
            fixtureNotes: [],
            id: "stubborn-control",
            label: "Stubborn control",
            sourcePaths: ["src/stubborn.tsx"],
          },
        ])
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
      const { stdout } = await execFileAsync("bun", [scriptPath], {
        env: {
          ...process.env,
          NODE_PATH: join(process.cwd(), "node_modules"),
        },
        timeout: 30_000,
      });
      const marker = stdout.split("[makeademo:exploration] ")[1];
      expect(marker).toBeDefined();
      const result = JSON.parse((marker ?? "").trim()) as {
        declaredProofs?: Array<{
          detail: string;
          featureId: string;
          passed: boolean;
        }>;
        fatalError?: string;
      };

      expect(result.fatalError).toBeUndefined();
      const byFeature = new Map(
        (result.declaredProofs ?? []).map((proof) => [proof.featureId, proof]),
      );
      expect(byFeature.get("post-article")?.passed).toBe(true);
      expect(byFeature.get("follow-author")?.passed).toBe(true);
      expect(byFeature.get("follow-author")?.detail).toContain("Unfollow");
      expect(byFeature.get("stubborn-control")?.passed).toBe(false);
      expect(byFeature.get("stubborn-control")?.detail).toContain("Convinced");
    } finally {
      server.close();
    }
  }, 40_000);

  it("re-harvests a feature entry route whose first paint rendered nothing", async () => {
    // The first hit races a cold compile and serves only a skeleton; every
    // later hit renders the real page. A feature entry route about to be
    // reported content-free must get one fresh navigation before that
    // verdict stands, so a flaky first paint costs seconds, not a repair
    // round.
    const skeletonPage = `<!doctype html><html><head><title>Fleet App</title></head><body>
<input placeholder="Loading" />
</body></html>`;
    const contentPage = `<!doctype html><html><head><title>Fleet App</title></head><body>
<h1>Fleet dashboard</h1>
<main><p>Seven vehicles are currently active</p></main>
</body></html>`;
    let rootHits = 0;
    const server = createServer((request, response) => {
      if ((request.url ?? "/").split("?")[0] === "/") {
        rootHits += 1;
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(rootHits === 1 ? skeletonPage : contentPage);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
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
        join(tmpdir(), "makeademo-explorer-reharvest-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`, [
          {
            authStrategy: "none",
            description: "Watch the vehicle fleet dashboard.",
            entryPaths: ["/"],
            fixtureNotes: [],
            id: "fleet-dashboard",
            label: "Fleet dashboard",
            sourcePaths: ["src/dashboard.tsx"],
          },
        ])
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        routes: Array<{ headings: string[]; text: string[] }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.routes[0]?.headings).toContain("Fleet dashboard");
      expect(result.routes[0]?.text).toContain(
        "Seven vehicles are currently active",
      );
    } finally {
      server.close();
    }
  }, 30_000);

  it("reports a headers-only table as an empty data table and a populated one as none", async () => {
    // A data query that resolves empty or mis-shaped renders a table shell
    // with headers and no rows — silently, with no error and no request.
    const emptyTablePage = `<!doctype html><html><head><title>Ledger App</title></head><body>
<main>
<table><thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead><tbody></tbody></table>
<table><thead><tr><th>Customer</th></tr></thead><tbody><tr><td>Aperture Labs</td></tr></tbody></table>
</main>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(emptyTablePage);
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
        join(tmpdir(), "makeademo-explorer-empty-table-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
          emptyDataTables?: Array<{
            columnHeaders: number;
            headerTexts: string[];
          }>;
        }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.routes[0]?.emptyDataTables).toEqual([
        {
          columnHeaders: 3,
          headerTexts: ["Date", "Description", "Amount"],
        },
      ]);
    } finally {
      server.close();
    }
  }, 30_000);

  it("harvests populated data-table row text even when the selector harvest is rich", async () => {
    // The canonical data surface of an admin page is its table rows, but
    // cell text sits outside every paragraph/list selector and the page
    // title is not an h1-h3. When icon-ligature and skip-link junk makes
    // the selector harvest look rich, the aria fallback never fires — so
    // populated rows must be harvested directly, not via the fallback.
    const adminTablePage = `<!doctype html><html><head><title>Admin App</title></head><body>
<main>
<nav><ul><li><a href="/">Settings</a></li></ul></nav>
<ul><li>people_alt</li><li>folder</li><li>insights</li><li>bookmark</li><li>translate</li><li>public</li><li>storage</li><li>tune</li></ul>
<div class="title">Access Policies</div>
<table><thead><tr><th>Name</th><th>Roles</th></tr></thead>
<tbody><tr><td>Article API Access</td><td>1 role</td></tr><tr><td>Editors</td><td>3 roles</td></tr></tbody></table>
</main>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(adminTablePage);
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
        join(tmpdir(), "makeademo-explorer-rows-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
          emptyDataTables?: Array<{ columnHeaders: number }>;
          populatedDataTables?: number;
          text: string[];
        }>;
      };

      expect(result.fatalError).toBeUndefined();
      const route = result.routes[0];
      expect(route?.text).toContain("Article API Access");
      expect(route?.text).toContain("Editors");
      expect(route?.populatedDataTables).toBe(1);
      expect(route?.emptyDataTables).toEqual([]);
    } finally {
      server.close();
    }
  }, 30_000);

  it("keeps empty-table header text out of the accessibility-tree harvest", async () => {
    // A zero-row table still exposes its column headers to the aria tree —
    // as individual header cells and as the combined header-row name. Neither
    // may enter route text as content evidence, while non-table aria text on
    // the same thin page must still be harvested.
    const skeletonPage = `<!doctype html><html><head><title>Ledger App</title></head><body>
<main>
<nav><ul><li><a href="/">Overview</a></li></ul></nav>
<input placeholder="Search invoices..." />
<div>Pending invoices overview</div>
<table><thead><tr><th>Invoice no.</th><th>Due date</th><th>Amount</th></tr></thead><tbody></tbody></table>
</main>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(skeletonPage);
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
        join(tmpdir(), "makeademo-explorer-header-aria-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        routes: Array<{ text: string[] }>;
      };

      expect(result.fatalError).toBeUndefined();
      const text = result.routes[0]?.text ?? [];
      expect(text).toContain("Pending invoices overview");
      expect(text).not.toContain("Invoice no.");
      expect(text).not.toContain("Invoice no. Due date Amount");
    } finally {
      server.close();
    }
  }, 30_000);

  it("harvests a later route's plain-div content despite chrome repeated from earlier routes", async () => {
    // Icon-ligature and skip-link strings escape the nav selectors and
    // repeat on every route. They must not crowd the aria candidate budget
    // on later routes, where a data page's real content (here, text in a
    // plain div) still has to be seen.
    const junk =
      "<ul><li>people_alt</li><li>folder</li><li>insights</li><li>bookmark</li><li>translate</li><li>public</li><li>storage</li><li>tune</li></ul>";
    const navigation =
      '<nav><a href="/">Home</a> <a href="/policies">Policies</a></nav>';
    const homePage = `<!doctype html><html><head><title>Admin App</title></head><body>
<main>${navigation}${junk}</main>
</body></html>`;
    const policiesPage = `<!doctype html><html><head><title>Admin App</title></head><body>
<main>${navigation}${junk}
<div>Pending approvals overview</div>
</main>
</body></html>`;
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        request.url?.startsWith("/policies") ? policiesPage : homePage,
      );
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
        join(tmpdir(), "makeademo-explorer-repeats-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        routes: Array<{ path: string; text: string[] }>;
      };

      expect(result.fatalError).toBeUndefined();
      const policies = result.routes.find((route) =>
        route.path.startsWith("/policies"),
      );
      expect(policies).toBeDefined();
      expect(policies?.text).toContain("Pending approvals overview");
    } finally {
      server.close();
    }
  }, 30_000);

  it("keeps stylesheet text out of harvested headings", async () => {
    const styledHeadingPage = `<!doctype html><html><head><title>Styled App</title></head><body>
<div role="heading" aria-level="1"><style>.decor{color:red}</style>Quarterly report</div>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(styledHeadingPage);
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
        join(tmpdir(), "makeademo-explorer-styled-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        routes: Array<{ headings: string[] }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.routes[0]?.headings).toContain("Quarterly report");
      expect(result.routes[0]?.headings.join(" ")).not.toContain("{");
    } finally {
      server.close();
    }
  }, 30_000);

  it("abandons in-flight waits once the exploration deadline passes", async () => {
    // Responses arrive only after 20s — far beyond a clamped goto budget but
    // inside an unclamped 60s one.
    const pendingTimers: NodeJS.Timeout[] = [];
    const server = createServer((_request, response) => {
      pendingTimers.push(
        setTimeout(() => {
          try {
            response.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
            });
            response.end(
              "<!doctype html><html><head><title>Slow</title></head><body><h1>Slow app</h1></body></html>",
            );
          } catch {}
        }, 20_000),
      );
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
      )
        .replaceAll("/workspace/.makeademo/exploration", outputDirectory)
        .replace(
          /deadlineAtMs = Date\.now\(\) \+ \d+/,
          "deadlineAtMs = Date.now() + 2000",
        );
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);

      const startedAt = Date.now();
      const { stdout } = await execFileAsync("bun", [scriptPath], {
        env: {
          ...process.env,
          NODE_PATH: join(process.cwd(), "node_modules"),
        },
        timeout: 25_000,
      });
      const elapsedMs = Date.now() - startedAt;
      const marker = stdout.split("[makeademo:exploration] ")[1];
      expect(marker).toBeDefined();
      const result = JSON.parse((marker ?? "").trim()) as {
        routes: unknown[];
        unreachableRoutes: unknown[];
      };

      // The script must finalize shortly after its deadline instead of
      // riding out full-length navigation waits.
      expect(elapsedMs).toBeLessThan(8_000);
      expect(result.routes).toHaveLength(0);
      expect(result.unreachableRoutes.length).toBeGreaterThan(0);
    } finally {
      for (const timer of pendingTimers) clearTimeout(timer);
      server.close();
    }
  }, 30_000);

  it("records the failing resource URL when a page asset 404s", async () => {
    // A page whose entry module 404s while the document itself is a healthy
    // 200. The repair agent needs the missing PATH, not the page URL —
    // Chrome's own console message omits it.
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<!doctype html><html><head><title>Shell</title></head><body>" +
            "<h1>Publishing dashboard</h1><p>Draft queue and review status.</p>" +
            '<script type="module" src="/app/missing-entry.js"></script>' +
            "</body></html>",
        );
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
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
        consoleErrors: string[];
      };

      const resourceFailure = result.consoleErrors.find((entry) =>
        entry.includes("/app/missing-entry.js"),
      );
      expect(resourceFailure).toBeDefined();
      expect(resourceFailure).toContain("HTTP 404");
    } finally {
      server.close();
    }
  }, 30_000);

  it("keeps one console entry per repeated error class", async () => {
    // midday (2026-08-07 matrix): all ten visible consoleErrors entries were
    // the same HMR websocket handshake failure differing only in its ?id=
    // query, drowning the bounded evidence channel. One entry per class is
    // enough; genuinely different errors must still get through.
    const noisyPage =
      "<!doctype html><html><head><title>Noise</title></head><body>" +
      "<h1>Publishing dashboard</h1><p>Draft queue and review status.</p>" +
      "<script>" +
      "for (let i = 0; i < 6; i += 1) {" +
      '  console.error("WebSocket connection to \'ws://127.0.0.1:3001/_next/webpack-hmr?id=token" + i + "\' failed: handshake error");' +
      "}" +
      'console.error("Hydration mismatch in DataTable");' +
      "</script></body></html>";
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(noisyPage);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
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
        consoleErrors: string[];
      };

      const hmrEntries = result.consoleErrors.filter((entry) =>
        entry.includes("webpack-hmr"),
      );
      expect(hmrEntries).toHaveLength(1);
      expect(
        result.consoleErrors.some((entry) =>
          entry.includes("Hydration mismatch in DataTable"),
        ),
      ).toBe(true);
    } finally {
      server.close();
    }
  }, 30_000);

  it("harvests text that renders only inside an open shadow root", async () => {
    // Vite's error overlay is a custom element with an open shadow root, so
    // its import error is the page's only content while innerText sees
    // nothing; web-component apps render real content the same way.
    const shadowOverlayPage = `<!doctype html><html><head><title>Overlay</title></head><body>
<div id="root"></div>
<script>
class ErrorOverlay extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = "<div>[plugin:vite:import-analysis] Failed to resolve import \\"@directus-extensions\\" from \\"src/extensions.ts\\". Does the file exist?</div>";
  }
}
customElements.define("vite-error-overlay", ErrorOverlay);
document.body.appendChild(document.createElement("vite-error-overlay"));
</script>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(shadowOverlayPage);
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
        join(tmpdir(), "makeademo-explorer-shadow-"),
      );
      // The page has no light-DOM content, so the content waits run long;
      // clamp the script's own deadline the way the deadline test does.
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      )
        .replaceAll("/workspace/.makeademo/exploration", outputDirectory)
        .replace(
          /deadlineAtMs = Date\.now\(\) \+ \d+/,
          "deadlineAtMs = Date.now() + 15000",
        );
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        routes: Array<{ text: string[] }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.routes[0]?.text.join(" ")).toContain(
        "Failed to resolve import",
      );
    } finally {
      server.close();
    }
  }, 30_000);

  it("reports a same-origin script 5xx and leaves other failed resources out", async () => {
    // N128 (twenty, 2026-08-13): Vite answered 500 on the entry chunk, so
    // every route was the error overlay; the backend needs the failing
    // script's URL and status to call it a serve failure instead of
    // interpreting the hollow page as empty app state.
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/src/index.tsx")) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("[vite] Internal server error: transform failed");
        return;
      }
      if (request.url?.startsWith("/missing.js")) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Vite + React</title></head><body>
<div id="root"></div>
<script type="module" src="/src/index.tsx"></script>
<script src="/missing.js"></script>
</body></html>`);
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
        join(tmpdir(), "makeademo-explorer-5xx-"),
      );
      // The page renders nothing, so the content waits run long; clamp the
      // script's own deadline the way the shadow-root test does.
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      )
        .replaceAll("/workspace/.makeademo/exploration", outputDirectory)
        .replace(
          /deadlineAtMs = Date\.now\(\) \+ \d+/,
          "deadlineAtMs = Date.now() + 15000",
        );
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        failedScriptResponses?: Array<{ status: number; url: string }>;
        fatalError?: string;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.failedScriptResponses).toEqual([
        {
          status: 500,
          url: `http://127.0.0.1:${address.port}/src/index.tsx`,
        },
      ]);
    } finally {
      server.close();
    }
  }, 30_000);

  it("carries shadow-rooted overlay text as the route's text sample", async () => {
    // body.innerText cannot see into the overlay's shadow root, so the
    // bare-error-body sample comes up empty; the aria-derived text must
    // fill the sample or the backend reads the route as silently blank.
    const shadowOverlayPage = `<!doctype html><html><head><title>Overlay</title></head><body>
<div id="root"></div>
<script>
class ErrorOverlay extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = "<div>[plugin:vite:import-analysis] Failed to resolve import \\"@directus-extensions\\" from \\"src/extensions.ts\\". Does the file exist?</div>";
  }
}
customElements.define("vite-error-overlay", ErrorOverlay);
document.body.appendChild(document.createElement("vite-error-overlay"));
</script>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(shadowOverlayPage);
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
        join(tmpdir(), "makeademo-explorer-shadow-sample-"),
      );
      const script = (
        await buildExplorerScript(`http://127.0.0.1:${address.port}`)
      )
        .replaceAll("/workspace/.makeademo/exploration", outputDirectory)
        .replace(
          /deadlineAtMs = Date\.now\(\) \+ \d+/,
          "deadlineAtMs = Date.now() + 15000",
        );
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        routes: Array<{ textSample?: string }>;
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.routes[0]?.textSample).toContain(
        "Failed to resolve import",
      );
    } finally {
      server.close();
    }
  }, 30_000);

  it("crawls only declared feature entry routes in feature-entries scope", async () => {
    // N108: the preparation-time feature probe re-runs the gate's own
    // harvest, but scoped to the manifest's entry routes — a link the full
    // crawl would follow must stay unvisited so the probe's cost tracks the
    // feature count, not the app's link graph.
    const pages = new Map([
      [
        "/",
        `<!doctype html><html><head><title>Home</title></head><body>
<h1>Control room</h1><a href="/hidden">Archived reports</a>
<main><p>Operations overview for the demo workspace</p></main>
</body></html>`,
      ],
      [
        "/hidden",
        "<!doctype html><html><head><title>Hidden</title></head><body><h1>Archived reports</h1></body></html>",
      ],
      [
        "/panel",
        `<!doctype html><html><head><title>Panel</title></head><body>
<h1>Signal panel</h1><main><p>Live signal strength for every relay</p></main>
</body></html>`,
      ],
    ]);
    const server = createServer((request, response) => {
      const page = pages.get(new URL(request.url ?? "/", "http://s").pathname);
      response.writeHead(page === undefined ? 404 : 200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(page ?? "<!doctype html><html><body>missing</body></html>");
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
        join(tmpdir(), "makeademo-explorer-scope-"),
      );
      const script = (
        await buildExplorerScript(
          `http://127.0.0.1:${address.port}`,
          [
            {
              authStrategy: "none",
              description: "Watch live relay signal strength.",
              entryPaths: ["/panel"],
              fixtureNotes: [],
              id: "signal-panel",
              label: "Signal panel",
              sourcePaths: ["src/panel.tsx"],
            },
          ],
          "feature-entries",
        )
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
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
        routes: Array<{ headings: string[]; path: string }>;
      };

      expect(result.fatalError).toBeUndefined();
      const crawledPaths = result.routes
        .map((route) => route.path)
        .filter((path) => !path.includes("__makeademo-404-probe__"));
      expect(crawledPaths).toContain("/panel");
      expect(crawledPaths).toContain("/");
      expect(crawledPaths).not.toContain("/hidden");
      expect(
        result.routes.find((route) => route.path === "/panel")?.headings,
      ).toContain("Signal panel");
    } finally {
      server.close();
    }
  }, 30_000);

  it("re-verifies a capture-failed candidate after replaying its scene prefix", async () => {
    // N125: the failed candidate's element exists only in the state the
    // scene's earlier actions produce. A fresh-route verification would
    // certify or reject it in the wrong context; the replay verification
    // must execute the prefix first and find the element reproduced.
    const editorPage = `<!doctype html><html><head><title>Editor App</title></head><body>
<h1>Records workspace</h1>
<main><p>Weekly records for the demo workspace</p></main>
<button onclick="document.getElementById('panel').innerHTML='<button>Save entry</button>'">Open editor</button>
<div id="panel"></div>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(editorPage);
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
        join(tmpdir(), "makeademo-explorer-replay-"),
      );
      const script = (
        await buildExplorerScript(
          `http://127.0.0.1:${address.port}`,
          undefined,
          undefined,
          {
            actionId: "click-save",
            locator: { name: "Save entry", role: "button", strategy: "role" },
            locatorCandidateId: "save-entry-locator-1",
            sceneId: "scene-editor",
            scenePrefix: [
              { id: "goto-root", path: "/", type: "goto" },
              {
                id: "open-editor",
                locator: {
                  name: "Open editor",
                  role: "button",
                  strategy: "role",
                },
                type: "click",
              },
            ],
          },
        )
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
      const { stdout } = await execFileAsync("bun", [scriptPath], {
        env: {
          ...process.env,
          NODE_PATH: join(process.cwd(), "node_modules"),
        },
        timeout: 60_000,
      });
      const marker = stdout.split("[makeademo:exploration] ")[1];
      expect(marker).toBeDefined();
      const result = JSON.parse((marker ?? "").trim()) as {
        fatalError?: string;
        replayVerification?: {
          actionId: string;
          detail: string;
          locatorCandidateId?: string;
          reproduced: boolean;
          sceneId: string;
        };
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.replayVerification).toMatchObject({
        actionId: "click-save",
        locatorCandidateId: "save-entry-locator-1",
        reproduced: true,
        sceneId: "scene-editor",
      });
    } finally {
      server.close();
    }
  }, 60_000);

  it("reports a candidate its scene prefix cannot reproduce as unreproduced", async () => {
    // N125: when the element is absent even in the replayed state, the
    // evidence is unreproducible at replay — app-state divergence, not a
    // locator drafting problem — and the verdict must say so.
    const editorPage = `<!doctype html><html><head><title>Editor App</title></head><body>
<h1>Records workspace</h1>
<main><p>Weekly records for the demo workspace</p></main>
<button onclick="document.getElementById('panel').innerHTML='<button>Save entry</button>'">Open editor</button>
<div id="panel"></div>
</body></html>`;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(editorPage);
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
        join(tmpdir(), "makeademo-explorer-replay-"),
      );
      const script = (
        await buildExplorerScript(
          `http://127.0.0.1:${address.port}`,
          undefined,
          undefined,
          {
            actionId: "click-publish",
            locator: {
              name: "Publish entry",
              role: "button",
              strategy: "role",
            },
            locatorCandidateId: "publish-entry-locator-1",
            sceneId: "scene-editor",
            scenePrefix: [
              { id: "goto-root", path: "/", type: "goto" },
              {
                id: "open-editor",
                locator: {
                  name: "Open editor",
                  role: "button",
                  strategy: "role",
                },
                type: "click",
              },
            ],
          },
        )
      ).replaceAll("/workspace/.makeademo/exploration", outputDirectory);
      const scriptPath = join(outputDirectory, "explore-app.mjs");
      await writeFile(scriptPath, script);
      const { stdout } = await execFileAsync("bun", [scriptPath], {
        env: {
          ...process.env,
          NODE_PATH: join(process.cwd(), "node_modules"),
        },
        timeout: 60_000,
      });
      const marker = stdout.split("[makeademo:exploration] ")[1];
      expect(marker).toBeDefined();
      const result = JSON.parse((marker ?? "").trim()) as {
        fatalError?: string;
        replayVerification?: { detail: string; reproduced: boolean };
      };

      expect(result.fatalError).toBeUndefined();
      expect(result.replayVerification).toMatchObject({
        actionId: "click-publish",
        reproduced: false,
        sceneId: "scene-editor",
      });
      expect(result.replayVerification?.detail).toContain(
        "after replaying 2 prefix action(s)",
      );
    } finally {
      server.close();
    }
  }, 60_000);
});
