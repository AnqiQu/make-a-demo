import { describe, expect, it } from "vitest";
import { parseDemoScript } from "./demo-script.schema";

describe("parseDemoScript", () => {
  it("accepts a complete Demo Script artifact", () => {
    expect(parseDemoScript(validDemoScript())).toMatchObject({
      demoPlaywrightScript: expect.stringContaining("await scene"),
      presentation: {
        music: { enabled: true, trackId: "focus" },
        textOverlays: [expect.objectContaining({ sceneId: "scene_one" })],
        transitions: [],
      },
      scenes: [
        {
          expectedVisibleOutcome: "Main content is visible.",
          humanReadableDescription: "Show main content.",
          id: "scene_one",
        },
      ],
      scriptId: "script_001",
    });
  });

  it("defaults omitted presentation options to no music, overlays, or transitions", () => {
    expect(
      parseDemoScript({
        ...validDemoScript(),
        presentation: {},
      }).presentation,
    ).toEqual({
      music: { enabled: false },
      textOverlays: [],
      transitions: [],
    });
  });

  it("accepts a Scene without a human-readable description", () => {
    const script = validDemoScript();
    expect(
      parseDemoScript({
        ...script,
        scenes: [
          {
            expectedVisibleOutcome: "Main content is visible.",
            id: "scene_one",
          },
        ],
      }).scenes,
    ).toEqual([
      {
        expectedVisibleOutcome: "Main content is visible.",
        id: "scene_one",
        type: "playwright-recording",
      },
    ]);
  });

  it("accepts a text-only Demo Script without Playwright source", () => {
    const parsed = parseDemoScript({
      format: "16:9",
      presentation: {},
      scenes: [
        {
          backgroundColor: "#101828",
          durationSeconds: 3,
          id: "title-card",
          text: {
            color: "#ffffff",
            content: "Meet your new workspace",
            font: "Inter",
            position: "center",
            size: "large",
          },
          type: "full-screen-text",
        },
      ],
      scriptId: "script_001",
      title: "Demo Script",
      version: 1,
    });

    expect(parsed).not.toHaveProperty("demoPlaywrightScript");
    expect(parsed).toMatchObject({
      scenes: [
        {
          backgroundColor: "#101828",
          durationSeconds: 3,
          id: "title-card",
          text: {
            color: "#ffffff",
            content: "Meet your new workspace",
            font: "Inter",
            position: "center",
            size: "large",
          },
          type: "full-screen-text",
        },
      ],
    });
  });

  it("accepts a static-image Scene through a trusted asset ID", () => {
    const script = validDemoScript();

    expect(
      parseDemoScript({
        ...script,
        presentation: {},
        scenes: [
          {
            alt: "Product architecture diagram",
            assetId: "architecture-v2.png",
            durationSeconds: 2.5,
            id: "architecture",
            type: "static-image",
          },
        ],
      }).scenes,
    ).toEqual([
      {
        alt: "Product architecture diagram",
        assetId: "architecture-v2.png",
        durationSeconds: 2.5,
        id: "architecture",
        type: "static-image",
      },
    ]);
  });

  it("compiles typed browser Scene actions when Playwright source is omitted", () => {
    const parsed = parseDemoScript({
      format: "16:9",
      presentation: {},
      scenes: [
        {
          actions: [
            {
              id: "open-dashboard",
              path: "/dashboard",
              type: "goto",
            },
            {
              id: "dashboard-visible",
              locator: {
                name: "Dashboard",
                role: "heading",
                strategy: "role",
              },
              type: "assert-visible",
            },
          ],
          expectedVisibleOutcome: "The dashboard is visible.",
          id: "dashboard",
          type: "playwright-recording",
        },
      ],
      scriptId: "script_001",
      setupActions: [
        {
          id: "dismiss-welcome",
          locator: {
            name: "Dismiss",
            role: "button",
            strategy: "role",
          },
          type: "click",
        },
      ],
      title: "Demo Script",
      version: 1,
    });

    expect(parsed.setupActions).toMatchObject([
      { id: "dismiss-welcome", type: "click" },
    ]);
    expect(parsed.scenes[0]).toMatchObject({
      actions: [
        { id: "open-dashboard", path: "/dashboard", type: "goto" },
        { id: "dashboard-visible", type: "assert-visible" },
      ],
      type: "playwright-recording",
    });
    expect(parsed.demoPlaywrightScript).toContain('await scene("dashboard"');
    expect(parsed.demoPlaywrightScript).toContain(
      'page.getByRole("heading", { name: "Dashboard" })',
    );
    expect(parsed.demoPlaywrightScript).toContain(
      'page.getByRole("button", { name: "Dismiss" }).click()',
    );
  });

  it("accepts a durationless cut between adjacent Scenes", () => {
    const script = validDemoScript();

    expect(
      parseDemoScript({
        ...script,
        presentation: {
          transitions: [
            {
              fromSceneId: "scene_one",
              style: "cut",
              toSceneId: "scene_two",
            },
          ],
        },
        scenes: [scene("scene_one"), scene("scene_two")],
      }).presentation.transitions,
    ).toEqual([
      {
        fromSceneId: "scene_one",
        style: "cut",
        toSceneId: "scene_two",
      },
    ]);
  });

  it("rejects transitions that do not connect adjacent Scenes", () => {
    const script = validDemoScript();

    expect(() =>
      parseDemoScript({
        ...script,
        presentation: {
          transitions: [
            {
              durationSeconds: 0.3,
              fromSceneId: "scene_one",
              style: "fade",
              toSceneId: "scene_three",
            },
          ],
        },
        scenes: [scene("scene_one"), scene("scene_two"), scene("scene_three")],
      }),
    ).toThrow(
      "presentation.transitions[0] must connect adjacent Scenes in script order",
    );
  });

  it("rejects duplicate transition edges", () => {
    const script = validDemoScript();
    const transition = {
      durationSeconds: 0.3,
      fromSceneId: "scene_one",
      style: "fade",
      toSceneId: "scene_two",
    };

    expect(() =>
      parseDemoScript({
        ...script,
        presentation: { transitions: [transition, transition] },
        scenes: [scene("scene_one"), scene("scene_two")],
      }),
    ).toThrow("presentation.transitions[1] duplicates transition edge");
  });

  it("rejects unsupported video formats at the Demo Script boundary", () => {
    expect(() =>
      parseDemoScript({ ...validDemoScript(), format: "9:16" }),
    ).toThrow("format must be 16:9");
  });

  it("rejects Scene IDs that are unsafe to use in artifact paths", () => {
    expect(() =>
      parseDemoScript({
        ...validDemoScript(),
        presentation: {},
        scenes: [scene("../outside")],
      }),
    ).toThrow("scenes[0].id must be a safe identifier");
  });

  it("rejects Script IDs that are unsafe to use in artifact paths", () => {
    expect(() =>
      parseDemoScript({ ...validDemoScript(), scriptId: "../outside" }),
    ).toThrow("Demo Script.scriptId must be a safe identifier");
  });

  it("reserves the setup marker scope from use as a Scene ID", () => {
    expect(() =>
      parseDemoScript({
        ...validDemoScript(),
        presentation: {},
        scenes: [scene("setup")],
      }),
    ).toThrow('scenes[0].id must not use reserved identifier "setup"');
  });

  it("rejects unknown properties at every Demo Script object boundary", () => {
    const script = validDemoScript();
    const secondSceneScript = {
      ...script,
      presentation: {
        ...script.presentation,
        transitions: [
          {
            durationSeconds: 0.3,
            fromSceneId: "scene_one",
            style: "fade",
            toSceneId: "scene_two",
          },
        ],
      },
      scenes: [scene("scene_one"), scene("scene_two")],
    };
    const textOnlyScript = {
      format: "16:9",
      presentation: {},
      scenes: [
        {
          backgroundColor: "#101828",
          durationSeconds: 3,
          id: "title-card",
          text: {
            color: "#ffffff",
            content: "Meet your new workspace",
            font: "Inter",
            position: "center",
            size: "large",
          },
          type: "full-screen-text",
        },
      ],
      scriptId: "script_001",
      title: "Demo Script",
      version: 1,
    };
    const invalidCases: unknown[] = [
      { ...script, audio: { enabled: false } },
      { ...script, scenes: [{ ...script.scenes[0], typo: true }] },
      { ...script, presentation: { ...script.presentation, typo: true } },
      {
        ...script,
        presentation: {
          ...script.presentation,
          music: { enabled: true, trackId: "focus", typo: true },
        },
      },
      {
        ...script,
        presentation: {
          ...script.presentation,
          textOverlays: [
            { ...script.presentation.textOverlays[0], typo: true },
          ],
        },
      },
      {
        ...secondSceneScript,
        presentation: {
          ...secondSceneScript.presentation,
          transitions: [
            {
              ...secondSceneScript.presentation.transitions[0],
              typo: true,
            },
          ],
        },
      },
      {
        ...textOnlyScript,
        scenes: [
          {
            ...textOnlyScript.scenes[0],
            text: { ...textOnlyScript.scenes[0]?.text, typo: true },
          },
        ],
      },
    ];

    for (const invalid of invalidCases) {
      expect(() => parseDemoScript(invalid)).toThrow(/unsupported property/);
    }
  });

  it("rejects missing required Demo Script fields", () => {
    const invalidCases: Array<[string, unknown]> = [
      ["demoPlaywrightScript", { demoPlaywrightScript: "" }],
      [
        "expected visible outcome",
        { scenes: [{ expectedVisibleOutcome: "" }] },
      ],
      ["scene description", { scenes: [{ humanReadableDescription: "" }] }],
      ["music", { presentation: { music: null } }],
      ["text overlays", { presentation: { textOverlays: null } }],
      ["transitions", { presentation: { transitions: null } }],
      [
        "transition duration",
        {
          presentation: {
            transitions: [
              {
                durationSeconds: 0,
                fromSceneId: "scene_one",
                style: "fade",
                toSceneId: "scene_one",
              },
            ],
          },
        },
      ],
      [
        "overlay content",
        {
          presentation: {
            textOverlays: [{ content: "", sceneId: "scene_one" }],
          },
        },
      ],
    ];

    for (const [label, patch] of invalidCases) {
      expect(
        () => parseDemoScript(mergeDemoScript(validDemoScript(), patch)),
        label,
      ).toThrow();
    }
  });

  it("accepts only the current Demo Script document version", () => {
    expect(() => parseDemoScript({ ...validDemoScript(), version: 2 })).toThrow(
      "version must be 1",
    );
  });

  it("rejects unsupported presentation metadata", () => {
    const invalidCases: Array<[string, unknown]> = [
      [
        "font",
        {
          presentation: {
            textOverlays: [{ font: "Comic Sans", sceneId: "scene_one" }],
          },
        },
      ],
      [
        "music track",
        { presentation: { music: { enabled: true, trackId: "unknown" } } },
      ],
      [
        "transition style",
        {
          presentation: {
            transitions: [{ style: "wipe", toSceneId: "scene_one" }],
          },
        },
      ],
      [
        "text overlay scene",
        { presentation: { textOverlays: [{ sceneId: "scene_missing" }] } },
      ],
      [
        "transition scene",
        {
          presentation: {
            transitions: [{ fromSceneId: "scene_missing" }],
          },
        },
      ],
    ];

    for (const [, patch] of invalidCases) {
      expect(() =>
        parseDemoScript(mergeDemoScript(validDemoScript(), patch)),
      ).toThrow();
    }
  });

  it("rejects duplicate Scene IDs and agent-authored recorded Scene durations", () => {
    expect(() =>
      parseDemoScript({
        ...validDemoScript(),
        scenes: [scene("scene_one"), scene("scene_one")],
      }),
    ).toThrow("scenes[1].id must be unique");

    expect(() =>
      parseDemoScript({
        ...validDemoScript(),
        scenes: [{ ...scene("scene_one"), durationSeconds: 3 }],
      }),
    ).toThrow("scenes[0].durationSeconds is not allowed");
  });

  it("rejects Demo Scripts whose Scene collection exceeds the render budget", () => {
    expect(() =>
      parseDemoScript({
        ...validDemoScript(),
        presentation: {},
        scenes: Array.from({ length: 21 }, (_, index) =>
          scene(`scene_${index + 1}`),
        ),
      }),
    ).toThrow("scenes must contain at most 20 items");
  });

  it("rejects browser action collections that exceed the execution budget", () => {
    expect(() =>
      parseDemoScript({
        ...validDemoScript(),
        setupActions: Array.from({ length: 51 }, (_, index) => ({
          id: `setup_${index + 1}`,
          path: "/",
          type: "goto",
        })),
      }),
    ).toThrow("setupActions must contain at most 50 items");
  });

  it("rejects text overlay collections that exceed the presentation budget", () => {
    const script = validDemoScript();
    expect(() =>
      parseDemoScript({
        ...script,
        presentation: {
          ...script.presentation,
          textOverlays: Array.from({ length: 41 }, () => ({
            content: "Overlay",
            font: "Inter",
            position: "top-left",
            sceneId: "scene_one",
            size: "medium",
          })),
        },
      }),
    ).toThrow("presentation.textOverlays must contain at most 40 items");
  });

  it("rejects transition collections that exceed the Scene edge budget", () => {
    expect(() =>
      parseDemoScript({
        ...validDemoScript(),
        presentation: {
          transitions: Array.from({ length: 20 }, () => ({
            fromSceneId: "scene_one",
            style: "cut",
            toSceneId: "scene_two",
          })),
        },
        scenes: [scene("scene_one"), scene("scene_two")],
      }),
    ).toThrow("presentation.transitions must contain at most 19 items");
  });

  it("rejects synthetic Scenes shorter than the minimum renderable duration", () => {
    expect(() =>
      parseDemoScript({
        format: "16:9",
        presentation: {},
        scenes: [
          {
            backgroundColor: "#101828",
            durationSeconds: 0.49,
            id: "title-card",
            text: {
              color: "#ffffff",
              content: "Meet your new workspace",
              font: "Inter",
              position: "center",
              size: "large",
            },
            type: "full-screen-text",
          },
        ],
        scriptId: "script_001",
        title: "Demo Script",
        version: 1,
      }),
    ).toThrow("scenes[0].durationSeconds must be at least 0.5 seconds");
  });

  it("rejects synthetic Scenes longer than the per-Scene render budget", () => {
    const script = validDemoScript();
    expect(() =>
      parseDemoScript({
        ...script,
        presentation: {},
        scenes: [
          {
            alt: "Architecture diagram",
            assetId: "architecture.png",
            durationSeconds: 30.01,
            id: "architecture",
            type: "static-image",
          },
        ],
      }),
    ).toThrow("scenes[0].durationSeconds must be at most 30 seconds");
  });

  it("rejects Demo Scripts whose synthetic Scenes exceed the total duration budget", () => {
    expect(() =>
      parseDemoScript({
        format: "16:9",
        presentation: {},
        scenes: Array.from({ length: 7 }, (_, index) => ({
          backgroundColor: "#101828",
          durationSeconds: 30,
          id: `title_${index + 1}`,
          text: {
            color: "#ffffff",
            content: `Title ${index + 1}`,
            font: "Inter",
            position: "center",
            size: "large",
          },
          type: "full-screen-text",
        })),
        scriptId: "script_001",
        title: "Demo Script",
        version: 1,
      }),
    ).toThrow("synthetic Scenes must total at most 180 seconds");
  });

  it("rejects fades shorter than the minimum meaningful transition", () => {
    expect(() =>
      parseDemoScript({
        ...validDemoScript(),
        presentation: {
          transitions: [
            {
              durationSeconds: 0.09,
              fromSceneId: "scene_one",
              style: "fade",
              toSceneId: "scene_two",
            },
          ],
        },
        scenes: [scene("scene_one"), scene("scene_two")],
      }),
    ).toThrow(
      "presentation.transitions[0].durationSeconds must be at least 0.1 seconds",
    );
  });

  it("rejects fades longer than the transition render budget", () => {
    expect(() =>
      parseDemoScript({
        ...validDemoScript(),
        presentation: {
          transitions: [
            {
              durationSeconds: 3.01,
              fromSceneId: "scene_one",
              style: "fade",
              toSceneId: "scene_two",
            },
          ],
        },
        scenes: [scene("scene_one"), scene("scene_two")],
      }),
    ).toThrow(
      "presentation.transitions[0].durationSeconds must be at most 3 seconds",
    );
  });
});

function validDemoScript() {
  return {
    demoPlaywrightScript: [
      "import { setup, scene } from './makeademo-capture-sdk';",
      "await setup(async ({ page, baseUrl, expect }) => {",
      "  await page.goto(baseUrl);",
      "  await expect(page.locator('main')).toBeVisible();",
      "});",
      "await scene('scene_one', async ({ page, expect }) => {",
      "  await expect(page.locator('main')).toBeVisible();",
      "});",
    ].join("\n"),
    format: "16:9",
    presentation: {
      music: { enabled: true, trackId: "focus" },
      textOverlays: [
        {
          content: "Scene one",
          font: "Inter",
          position: "top-left",
          sceneId: "scene_one",
          size: "medium",
        },
      ],
      transitions: [],
    },
    scenes: [scene("scene_one")],
    scriptId: "script_001",
    title: "Demo Script",
    version: 1,
  };
}

function scene(id: string) {
  return {
    expectedVisibleOutcome: "Main content is visible.",
    humanReadableDescription: "Show main content.",
    id,
  };
}

function mergeDemoScript(base: Record<string, unknown>, patch: unknown) {
  return merge(base, patch) as unknown;
}

function merge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) {
    return patch === undefined ? base : patch;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = merge(merged[key], value);
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
