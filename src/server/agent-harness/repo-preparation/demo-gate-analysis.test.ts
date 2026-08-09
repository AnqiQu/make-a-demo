import { describe, expect, it } from "vitest";

import { analyzeDemoGateUsage } from "./demo-gate-analysis";

describe("analyzeDemoGateUsage", () => {
  it("recognizes a prefixed env read as a gate name and its binding as gated", () => {
    // excalidraw attempt 7 (2026-08-09): the Vite-required VITE_ prefix made
    // the gate invisible to the delimiter-bound regex and the canonical
    // repair was vetoed twice. The pipeline owns the MAKEADEMO_DEMO token,
    // so any name containing it is the gate.
    const analysis = analyzeDemoGateUsage({
      fileName: "excalidraw-app/data/initialize.ts",
      source: [
        'const isMakeADemoDemo = import.meta.env.VITE_MAKEADEMO_DEMO === "true";',
        "if (isMakeADemoDemo) {",
        "  return { scene: getMakeADemoScene(), isExternalScene: false };",
        "}",
      ].join("\n"),
    });

    expect(analysis).toMatchObject({ hasConditionalGate: true });
    expect(analysis?.gateNames).toContain("VITE_MAKEADEMO_DEMO");
    expect(analysis?.gateBindings).toContain("isMakeADemoDemo");
  });

  it("recognizes a define-constant gate in a conditional", () => {
    // excalidraw attempt 6: `__MAKEADEMO_DEMO__` from a vite define block hit
    // the same underscore blind spot.
    const analysis = analyzeDemoGateUsage({
      fileName: "src/app.ts",
      source: "if (__MAKEADEMO_DEMO__) { seedDemoScene(); }",
    });

    expect(analysis).toMatchObject({ hasConditionalGate: true });
    expect(analysis?.gateNames).toContain("__MAKEADEMO_DEMO__");
  });

  it("follows gate bindings through multiple local hops into a ternary", () => {
    const analysis = analyzeDemoGateUsage({
      fileName: "src/config.ts",
      source: [
        "const raw = process.env.MAKEADEMO_DEMO;",
        'const isDemo = raw === "1";',
        "const enabled = isDemo;",
        "export const adapter = enabled ? demoAdapter : realAdapter;",
      ].join("\n"),
    });

    expect(analysis).toMatchObject({ hasConditionalGate: true });
    expect(analysis?.gateBindings).toEqual(
      expect.arrayContaining(["raw", "isDemo", "enabled"]),
    );
  });

  it("treats a gate-reading function used in a guard clause as gated", () => {
    const analysis = analyzeDemoGateUsage({
      fileName: "src/scene.ts",
      source: [
        "function isDemoMode() {",
        '  return process.env.MAKEADEMO_DEMO === "1";',
        "}",
        "export function loadScene() {",
        "  if (!isDemoMode()) return loadRemoteScene();",
        "  return demoScene;",
        "}",
      ].join("\n"),
    });

    expect(analysis).toMatchObject({ hasConditionalGate: true });
    expect(analysis?.gateBindings).toContain("isDemoMode");
  });

  it("treats a logical-operator selection as a conditional gate", () => {
    const analysis = analyzeDemoGateUsage({
      fileName: "src/adapter.js",
      source: [
        'const isDemo = process.env.MAKEADEMO_DEMO === "true";',
        "export const adapter = isDemo && demoAdapter;",
      ].join("\n"),
    });

    expect(analysis).toMatchObject({ hasConditionalGate: true });
  });

  it("reads a bracketed env access as a gate name", () => {
    const analysis = analyzeDemoGateUsage({
      fileName: "src/env.ts",
      source: 'const flag = process.env["NEXT_PUBLIC_MAKEADEMO_DEMO"];',
    });

    expect(analysis?.gateNames).toContain("NEXT_PUBLIC_MAKEADEMO_DEMO");
    expect(analysis?.gateBindings).toContain("flag");
  });

  it("does not report a conditional gate for an unconditional read", () => {
    const analysis = analyzeDemoGateUsage({
      fileName: "src/log.ts",
      source: [
        'const isDemo = process.env.MAKEADEMO_DEMO === "1";',
        "console.log(isDemo);",
      ].join("\n"),
    });

    expect(analysis).toMatchObject({ hasConditionalGate: false });
  });

  it("does not treat a bare string literal as a gate reference", () => {
    const analysis = analyzeDemoGateUsage({
      fileName: "src/banner.ts",
      source: 'if (banner.includes("MAKEADEMO_DEMO")) { show(); }',
    });

    expect(analysis).toMatchObject({
      gateNames: [],
      hasConditionalGate: false,
    });
  });

  it("honors known gate identifiers supplied by the caller", () => {
    const gated = analyzeDemoGateUsage({
      fileName: "src/hydrate.ts",
      knownGateIdentifiers: ["isDemo"],
      source: "if (isDemo) { appStore.authenticated = true; }",
    });
    const ungated = analyzeDemoGateUsage({
      fileName: "src/hydrate.ts",
      source: "if (isDemo) { appStore.authenticated = true; }",
    });

    expect(gated).toMatchObject({ hasConditionalGate: true });
    expect(ungated).toMatchObject({ hasConditionalGate: false });
  });

  it("records imported and declared names as bound", () => {
    const analysis = analyzeDemoGateUsage({
      fileName: "src/session.ts",
      source: [
        "import { isDemoMode } from '../utils/demo-mode';",
        "const localGate = isDemoMode;",
      ].join("\n"),
    });

    expect(analysis?.boundNames).toEqual(
      expect.arrayContaining(["isDemoMode", "localGate"]),
    );
  });

  it("analyzes the script block of a single-file component", () => {
    const analysis = analyzeDemoGateUsage({
      fileName: "src/App.vue",
      source: [
        "<template><div /></template>",
        '<script lang="ts">',
        'const isDemo = import.meta.env.MAKEADEMO_DEMO === "true";',
        "if (isDemo) { seed(); }",
        "</script>",
      ].join("\n"),
    });

    expect(analysis).toMatchObject({ hasConditionalGate: true });
  });

  it("returns undefined for non-JavaScript-family sources", () => {
    expect(
      analyzeDemoGateUsage({
        fileName: "backend/auth.py",
        source: 'if os.environ.get("MAKEADEMO_DEMO") == "1": return demo_user',
      }),
    ).toBeUndefined();
    expect(
      analyzeDemoGateUsage({
        fileName: "src/App.vue",
        source: "<template><div /></template>",
      }),
    ).toBeUndefined();
  });
});
