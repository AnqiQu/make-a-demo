import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createFakeAgentHarnessWorkspace } from "../daytona/workspace.test-helpers";
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

  it("discounts strings repeated from earlier routes when deciding a thin harvest", async () => {
    // Icon-ligature and skip-link strings escape the nav selectors and
    // repeat on every route. On later routes they must not make a thin
    // harvest look rich, or the accessibility-tree fallback never fires and
    // a data page's real content (here, text in a plain div) goes unseen.
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
});
