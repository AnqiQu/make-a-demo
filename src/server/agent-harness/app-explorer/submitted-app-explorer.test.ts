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
                  inputLocators: [
                    {
                      controlKind: "fill",
                      locator: { strategy: "placeholder", value: "Search" },
                      name: "Search",
                    },
                  ],
                  inputs: ["Search"],
                  links: [
                    {
                      href: "/dashboard",
                      locatorEvidence: {
                        locator: {
                          exact: false,
                          name: "Dashboard",
                          role: "link",
                          strategy: "role",
                        },
                        observedAccessibleName:
                          "Dashboard Open the project dashboard",
                        verification: {
                          matchCount: 1,
                          route: "/",
                          targetHref: "/dashboard",
                          visible: true,
                        },
                      },
                      name: "Dashboard",
                    },
                  ],
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
    expect(explorerScript).toContain("inputLocators");
    expect(explorerScript).toContain('controlKind: tag === "select"');
    expect(explorerScript).toContain(
      "No accessible label or placeholder was available for this observed control.",
    );
    expect(explorerScript).toContain("createVerifiedRoleLocatorEvidence");
    expect(explorerScript).toContain("await element.ariaSnapshot()");
    expect(explorerScript).toContain("candidateLocator.count()");
    expect(explorerScript).toContain("matchCount: 1");
    expect(explorerScript).toContain('page.url() + ": " + error.message');
    expect(result.kind).toBe("artifacts");
    if (result.kind !== "artifacts") {
      throw new Error("Expected exploration artifacts");
    }
    expect(result.validationReport.status).toBe("passed");
    expect(result.appMap).toMatchObject({
      baseUrl: "http://127.0.0.1:3000",
      candidateFlows: expect.arrayContaining(["Search"]),
      discoveredRoutes: [
        expect.objectContaining({ path: "/", title: "Example App" }),
      ],
      stableLocatorCandidates: expect.arrayContaining(['placeholder="Search"']),
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
        expect.objectContaining({
          kind: "fill",
          preferredLocator: {
            strategy: "placeholder",
            value: "Search",
          },
        }),
        expect.objectContaining({
          kind: "navigate",
          route: "/",
        }),
        expect.objectContaining({
          id: "click-link-1-1",
          locatorCandidates: [
            {
              id: "click-link-1-1-locator-1",
              locator: {
                exact: false,
                name: "Dashboard",
                role: "link",
                strategy: "role",
              },
              observedAccessibleName: "Dashboard Open the project dashboard",
              verification: {
                matchCount: 1,
                route: "/",
                targetHref: "/dashboard",
                visible: true,
              },
            },
          ],
          preferredLocatorCandidateId: "click-link-1-1-locator-1",
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

    expect(result.kind).toBe("artifacts");
    if (result.kind !== "artifacts") {
      throw new Error("Expected exploration artifacts");
    }
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

  it("grounds a visible assertion when an observed route has no heading", async () => {
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
              blockedNetworkAttempts: [],
              consoleErrors: [],
              pageErrors: [],
              routes: [
                {
                  buttons: [],
                  forms: [],
                  headings: [],
                  inputs: [],
                  links: [],
                  path: "/products",
                  primaryNavigation: [],
                  screenshot: "/workspace/.makeademo/exploration/products.png",
                  snapshot:
                    "/workspace/.makeademo/exploration/products.aria.yml",
                  text: ["Product list"],
                  title: "Products",
                },
              ],
            }),
          };
        },
      },
    });

    expect(result.kind).toBe("artifacts");
    if (result.kind !== "artifacts") {
      throw new Error("Expected exploration artifacts");
    }
    expect(result.actionCatalog.actions).toContainEqual(
      expect.objectContaining({
        kind: "assert",
        preferredLocator: {
          strategy: "text",
          value: "Product list",
        },
        route: "/products",
      }),
    );
  });

  it("uses an observed control as assertion evidence when a route has no heading or body text", async () => {
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
              blockedNetworkAttempts: [],
              consoleErrors: [],
              pageErrors: [],
              routes: [
                {
                  buttons: ["Create project"],
                  forms: [],
                  headings: [],
                  inputs: [],
                  links: [],
                  path: "/projects",
                  primaryNavigation: [],
                  screenshot: "/workspace/.makeademo/exploration/projects.png",
                  snapshot:
                    "/workspace/.makeademo/exploration/projects.aria.yml",
                  text: [],
                  title: "Projects",
                },
              ],
            }),
          };
        },
      },
    });

    expect(result.kind).toBe("artifacts");
    if (result.kind !== "artifacts") {
      throw new Error("Expected exploration artifacts");
    }
    expect(result.actionCatalog.actions).toContainEqual(
      expect.objectContaining({
        kind: "assert",
        preferredLocator: {
          name: "Create project",
          strategy: "role",
          value: "button",
        },
        route: "/projects",
      }),
    );
  });

  it("returns a typed repairable report when the browser discovers no routes", async () => {
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
              blockedNetworkAttempts: [],
              consoleErrors: [],
              pageErrors: [],
              routes: [],
            }),
          };
        },
      },
    });

    expect(result).toMatchObject({
      kind: "repairable-failure",
      validationReport: {
        failureClassification: "app route not discoverable",
        stage: "app-exploration",
        status: "failed",
        urlChecked: "http://127.0.0.1:3000",
      },
    });
  });
});
