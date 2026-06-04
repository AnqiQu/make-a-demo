import { describe, expect, it } from "vitest";
import { prepareStylizedPlaywrightScript } from "./stylized-playwright-script";

describe("prepareStylizedPlaywrightScript", () => {
  it("types filled text with human pacing instead of instantly setting the input", () => {
    const prepared = prepareStylizedPlaywrightScript(
      "await page.getByLabel(/message/i).fill('Show me the launch plan');",
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        pauseAfterSceneMs: 0,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain("const humanTypingDelayMs = 100;");
    expect(prepared).toContain(
      "await humanType(page, page.getByLabel(/message/i), 'Show me the launch plan');",
    );
    expect(prepared).not.toContain(".fill('Show me the launch plan')");
  });

  it("animates clicks through the visible recording pointer", () => {
    const prepared = prepareStylizedPlaywrightScript(
      "await page.getByRole('button', { name: /send/i }).click();",
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        pauseAfterSceneMs: 0,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain("async function animatedClick(page, locator)");
    expect(prepared).toContain(
      "await animatedClick(page, page.getByRole('button', { name: /send/i }));",
    );
    expect(prepared).not.toContain(
      "await page.getByRole('button', { name: /send/i }).click();",
    );
  });

  it("animates hovers through the visible recording pointer", () => {
    const prepared = prepareStylizedPlaywrightScript(
      "await page.getByRole('button', { name: /launch plan chat/i }).hover();",
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        pauseAfterSceneMs: 0,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain("async function animatedHover(page, locator)");
    expect(prepared).toContain(
      "await animatedHover(page, page.getByRole('button', { name: /launch plan chat/i }));",
    );
    expect(prepared).not.toContain(
      "await page.getByRole('button', { name: /launch plan chat/i }).hover();",
    );

    const hoverHelper = getFunctionSource(prepared, "animatedHover");
    expect(hoverHelper).toContain("await page.mouse.move(");
    expect(hoverHelper).not.toContain("target.click");
    expect(hoverHelper).not.toContain("target.hover");
    expect(hoverHelper).not.toContain("pulseRecordingPointer");
  });

  it("animates scripted transcript scrolls", () => {
    const prepared = prepareStylizedPlaywrightScript(
      `const transcript = page.getByRole('log', { name: /conversation transcript/i });
await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight; });
await transcript.evaluate((element) => { element.scrollTop = 0; });`,
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        pauseAfterSceneMs: 0,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain("async function animatedScrollTo(page, locator");
    expect(prepared).toContain(
      "async function showScrollCue(page, box, position)",
    );
    expect(prepared).toContain("async function hideScrollCue(page)");
    expect(prepared).toContain("await showScrollCue(page, box, position);");
    expect(prepared).toContain("await hideScrollCue(page);");
    expect(prepared).toContain(
      'await animatedScrollTo(page, transcript, "bottom");',
    );
    expect(prepared).toContain(
      'await animatedScrollTo(page, transcript, "top");',
    );
    expect(prepared).not.toContain("element.scrollTop = element.scrollHeight");
    expect(prepared).not.toContain("element.scrollTop = 0");
  });

  it("does not rewrite the recording helper internals when preparing full Playwright scripts", () => {
    const prepared = prepareStylizedPlaywrightScript(
      `import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const context = await browser.newContext({
  recordVideo: { dir: "artifacts/videos" },
});
const page = await context.newPage();
await page.getByRole("button", { name: /send/i }).click();
await context.close();
await browser.close();`,
      {
        baseUrl: "http://localhost:3000",
        headed: false,
        pauseAfterSceneMs: 0,
        videoDirectory: ".demo-capture-runs/run/playwright-videos",
      },
    );

    expect(prepared).toContain(
      'await animatedClick(page, page.getByRole("button", { name: /send/i }));',
    );
    expect(prepared).toContain("await target.click();");
  });
});

function getFunctionSource(source: string, functionName: string) {
  const start = source.indexOf(`async function ${functionName}`);
  expect(start).toBeGreaterThanOrEqual(0);

  const nextFunction = source.indexOf("\nasync function ", start + 1);
  if (nextFunction === -1) {
    return source.slice(start);
  }

  return source.slice(start, nextFunction);
}
