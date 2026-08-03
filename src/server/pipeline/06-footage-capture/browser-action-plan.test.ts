import { describe, expect, it } from "vitest";
import {
  compileBrowserActionPlan,
  createBrowserActionJsonSchema,
  readBrowserActions,
} from "./browser-action-plan";

describe("Browser Action Plan", () => {
  it("compiles typed browser actions into a canonical Capture SDK script", () => {
    const script = compileBrowserActionPlan({
      scenes: [
        {
          actions: readBrowserActions(
            [
              {
                id: "open-dashboard",
                locator: {
                  name: "Open dashboard",
                  role: "button",
                  strategy: "role",
                },
                sourceActionId: "catalog-open-dashboard",
                type: "click",
              },
              {
                id: "dashboard-visible",
                locator: {
                  name: "Dashboard",
                  role: "heading",
                  strategy: "role",
                },
                sourceActionId: "catalog-dashboard-visible",
                type: "assert-visible",
              },
            ],
            "scenes[0].actions",
          ),
          id: "dashboard",
        },
      ],
    });

    expect(script).toContain(
      "import { setup, scene, step } from './makeademo-capture-sdk';",
    );
    expect(script).toContain(
      'await page.goto(baseUrl, { waitUntil: "domcontentloaded" });',
    );
    expect(script).toContain('await scene("dashboard"');
    expect(script).toContain('await step("open-dashboard"');
    expect(script).toContain(
      'page.getByRole("button", { name: "Open dashboard" })',
    );
    expect(script).toContain(".click();");
    expect(script).toContain('await step("dashboard-visible"');
    expect(script).toContain(".toBeVisible();");
  });

  it("treats DOM readiness as navigation completion", () => {
    const script = compileBrowserActionPlan({
      scenes: [
        {
          actions: readBrowserActions([
            { id: "open-dashboard", path: "/dashboard", type: "goto" },
            {
              id: "dashboard-visible",
              locator: { strategy: "text", value: "Dashboard" },
              type: "assert-visible",
            },
          ]),
          id: "dashboard",
        },
      ],
    });

    expect(script).toContain(
      'await page.goto(baseUrl, { waitUntil: "domcontentloaded" });',
    );
    expect(script).toContain(
      'await page.goto(new URL("/dashboard", baseUrl).toString(), { waitUntil: "domcontentloaded" });',
    );
  });

  it("rejects every path that resolves off the app's own origin", () => {
    for (const path of [
      "https://example.com",
      "//evil.com",
      "/\\evil.com",
      "/\t/evil.com",
      "\\\\evil.com",
      "/\\/evil.com",
    ]) {
      expect(() =>
        readBrowserActions(
          [{ id: "leave-app", path, type: "goto" }],
          "actions",
        ),
      ).toThrow("actions[0].path must be a local app path");
      expect(() =>
        readBrowserActions(
          [{ id: "assert-away", path, type: "assert-url" }],
          "actions",
        ),
      ).toThrow("actions[0].path must be a local app path");
    }

    for (const path of ["/dashboard", "/a/b?c=1#d", "#section", "?tab=two"]) {
      expect(() =>
        readBrowserActions([{ id: "stay", path, type: "goto" }], "actions"),
      ).not.toThrow();
    }
  });

  it("rejects unsafe navigation and unknown action properties", () => {
    expect(() =>
      readBrowserActions(
        [{ id: "leave-app", path: "https://example.com", type: "goto" }],
        "actions",
      ),
    ).toThrow("actions[0].path must be a local app path");

    expect(() =>
      readBrowserActions(
        [
          {
            id: "click",
            locator: { strategy: "text", value: "Continue" },
            surprise: true,
            type: "click",
          },
        ],
        "actions",
      ),
    ).toThrow("actions[0] contains unsupported property surprise");
  });

  it("rejects duplicate action IDs within one execution scope", () => {
    expect(() =>
      readBrowserActions([
        { id: "open", path: "/one", type: "goto" },
        { id: "open", path: "/two", type: "goto" },
      ]),
    ).toThrow("actions[1].id must be unique within actions");
  });

  it("requires each browser scene to prove a visible outcome", () => {
    expect(() =>
      compileBrowserActionPlan({
        scenes: [
          {
            actions: readBrowserActions(
              [
                {
                  id: "open-dashboard",
                  locator: {
                    name: "Open dashboard",
                    role: "button",
                    strategy: "role",
                  },
                  type: "click",
                },
              ],
              "scenes[0].actions",
            ),
            id: "dashboard",
          },
        ],
      }),
    ).toThrow(
      "Browser scene dashboard must include a visible assertion action",
    );
  });

  it("publishes a strict JSON Schema for every supported browser action", () => {
    const schema = createBrowserActionJsonSchema();

    expect(schema).toMatchObject({
      items: { oneOf: expect.any(Array) },
      type: "array",
    });
    expect(schema.items.oneOf).toHaveLength(11);
    expect(
      schema.items.oneOf.every(
        (actionSchema) => actionSchema.additionalProperties === false,
      ),
    ).toBe(true);
  });

  it("compiles text assertions with explicit visibility proof", () => {
    const script = compileBrowserActionPlan({
      scenes: [
        {
          actions: readBrowserActions([
            {
              id: "welcome-copy",
              locator: { strategy: "text", value: "Welcome back" },
              text: "Welcome back",
              type: "assert-text",
            },
          ]),
          id: "welcome",
        },
      ],
    });

    expect(script).toContain(
      'await expect(page.getByText("Welcome back")).toBeVisible();',
    );
    expect(script).toContain(
      'await expect(page.getByText("Welcome back")).toContainText("Welcome back");',
    );
  });

  it("compiles a grounded scroll without accepting arbitrary browser code", () => {
    const script = compileBrowserActionPlan({
      scenes: [
        {
          actions: readBrowserActions([
            {
              id: "scroll-feed",
              locator: { strategy: "css", value: "html" },
              position: "bottom",
              sourceActionId: "catalog-scroll-feed",
              type: "scroll",
            },
            {
              id: "feed-footer-visible",
              locator: { strategy: "text", value: "End of feed" },
              sourceActionId: "catalog-feed-footer-visible",
              type: "assert-visible",
            },
          ]),
          id: "scrolling-feed",
        },
      ],
    });

    expect(script).toContain(
      'await page.locator("html").evaluate((element) => { element.scrollTop = element.scrollHeight; });',
    );
    expect(createBrowserActionJsonSchema().items.oneOf).toHaveLength(11);
  });

  it("supports intentionally clearing an input with an empty fill value", () => {
    expect(
      readBrowserActions([
        {
          id: "clear-search",
          locator: { strategy: "label", value: "Search" },
          sourceActionId: "clear-search",
          type: "fill",
          value: "",
        },
      ]),
    ).toEqual([
      expect.objectContaining({ id: "clear-search", type: "fill", value: "" }),
    ]);
  });

  it("compiles XPath locators with Playwright's explicit selector engine", () => {
    const script = compileBrowserActionPlan({
      scenes: [
        {
          actions: readBrowserActions([
            {
              id: "result-visible",
              locator: { strategy: "xpath", value: "//main/h1" },
              type: "assert-visible",
            },
          ]),
          id: "result",
        },
      ],
    });

    expect(script).toContain('page.locator("xpath=//main/h1")');
  });
});
