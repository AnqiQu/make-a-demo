import { describe, expect, it } from "vitest";
import { exploreSubmittedApp } from "./submitted-app-explorer";

describe("exploreSubmittedApp", () => {
  it("grounds routes and actions in a Playwright observation from the submitted-code sandbox", async () => {
    const commands: string[] = [];
    const result = await exploreSubmittedApp({
      baseUrl: "http://127.0.0.1:3000",
      preparationManifestId: "prep_001",
      workspace: {
        async destroy() {},
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async executeSubmittedCode(command) {
          commands.push(command);
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              blockedNetworkAttempts: [],
              consoleErrors: [],
              pageErrors: [],
              routes: [
                {
                  buttons: ["Open dashboard"],
                  forms: [],
                  headings: ["Welcome"],
                  inputs: [],
                  links: [{ href: "/dashboard", name: "Dashboard" }],
                  path: "/",
                  primaryNavigation: ["Dashboard"],
                  screenshot: "/workspace/.makeademo/exploration/root.png",
                  snapshot: "/workspace/.makeademo/exploration/root.aria.yml",
                  text: ["Welcome", "Build something great"],
                  title: "Example App",
                },
              ],
            }),
          };
        },
      },
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(
      'NODE_PATH="$(npm root -g)" bun /workspace/.makeademo/exploration/explore-app.mjs',
    );
    const encodedScript = /printf %s '([^']+)'/.exec(commands[0] ?? "")?.[1];
    expect(encodedScript).toBeDefined();
    const explorerScript = Buffer.from(encodedScript ?? "", "base64").toString(
      "utf8",
    );
    expect(explorerScript).toContain("href: target.href");
    expect(explorerScript).toContain(
      "sameOrigin: target.origin === location.origin",
    );
    expect(explorerScript).toContain('page.url() + ": " + error.message');
    expect(result.validationReport.status).toBe("passed");
    expect(result.appMap).toMatchObject({
      baseUrl: "http://127.0.0.1:3000",
      discoveredRoutes: [
        expect.objectContaining({ path: "/", title: "Example App" }),
      ],
    });
    expect(result.actionCatalog.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "click",
          preferredLocator: {
            name: "Open dashboard",
            strategy: "role",
            value: "button",
          },
        }),
        expect.objectContaining({
          kind: "assert",
          preferredLocator: {
            name: "Welcome",
            strategy: "role",
            value: "heading",
          },
        }),
      ]),
    );
  });

  it("reports unique attempted external resources together with page errors", async () => {
    const result = await exploreSubmittedApp({
      baseUrl: "http://127.0.0.1:3000",
      preparationManifestId: "prep_001",
      workspace: {
        async destroy() {},
        async execute() {
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        async executeSubmittedCode() {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              blockedNetworkAttempts: [
                { host: "api.example.com", url: "https://api.example.com/v1" },
                { host: "api.example.com", url: "https://api.example.com/v1" },
              ],
              consoleErrors: [],
              pageErrors: ["http://127.0.0.1:3000/: render failed"],
              routes: [
                {
                  buttons: [],
                  forms: [],
                  headings: ["Welcome"],
                  inputs: [],
                  links: [],
                  path: "/",
                  primaryNavigation: [],
                  screenshot: "/workspace/.makeademo/exploration/root.png",
                  snapshot: "/workspace/.makeademo/exploration/root.aria.yml",
                  text: ["Welcome"],
                  title: "Example App",
                },
              ],
            }),
          };
        },
      },
    });

    expect(result.validationReport).toMatchObject({
      failureClassification: "external network attempted",
      blockedNetworkAttempts: [
        expect.objectContaining({ url: "https://api.example.com/v1" }),
      ],
      status: "failed",
    });
    expect(result.validationReport.blockedNetworkAttempts).toHaveLength(1);
    expect(result.validationReport.logsSummary).toContain(
      "1 unique external network request",
    );
    expect(result.validationReport.logsSummary).toContain("1 page error");
  });
});
