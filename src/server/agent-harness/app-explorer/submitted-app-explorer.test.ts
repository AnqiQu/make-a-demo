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

  it("fails exploration when the running app attempts external network access", async () => {
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
              ],
              consoleErrors: [],
              pageErrors: [],
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
      failureClassification: "external network required",
      status: "failed",
    });
  });
});
