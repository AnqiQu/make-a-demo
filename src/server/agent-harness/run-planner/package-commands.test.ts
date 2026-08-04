import { describe, expect, it } from "vitest";
import {
  createInstallCommand,
  createRunScriptCommand,
  isDevServerScriptBody,
  readCandidatePorts,
  readScriptPort,
} from "./package-commands";

describe("readScriptPort", () => {
  it("reads every supported port spelling with the last flag winning", () => {
    expect(readScriptPort("vite --port=4300")).toBe(4300);
    expect(readScriptPort("next dev -p 3001")).toBe(3001);
    expect(readScriptPort("PORT=3105 next dev")).toBe(3105);
    expect(readScriptPort("serve -s dist -l 5000")).toBe(5000);
    expect(readScriptPort("vite --port 4000 --port 4100")).toBe(4100);
    expect(readScriptPort("next build")).toBeUndefined();
  });
});

describe("readCandidatePorts", () => {
  it("collects flag, env, and localhost ports across scripts ascending", () => {
    expect(
      readCandidatePorts({
        dev: "PORT=3105 next dev",
        e2e: "wait-on http://localhost:3105 && playwright test",
        preview: "vite preview --port=4300",
      }),
    ).toEqual([3105, 4300]);
  });
});

describe("createRunScriptCommand", () => {
  it("always uses the run form so builtin tool names cannot shadow scripts", () => {
    expect(createRunScriptCommand("bun", "build")).toBe("bun run build");
    expect(createRunScriptCommand("yarn", "dev")).toBe("yarn run dev");
    expect(createRunScriptCommand("unknown", "dev")).toBe("npm run dev");
  });
});

describe("createInstallCommand", () => {
  it("avoids npm ci for an unknown manager because no lockfile is proven", () => {
    expect(createInstallCommand("unknown")).toBe("npm install --no-audit");
    expect(createInstallCommand("pnpm")).toBe("pnpm install --frozen-lockfile");
  });
});

describe("isDevServerScriptBody", () => {
  it("separates dev servers from static file servers by the script body", () => {
    expect(isDevServerScriptBody("vite --port 4300")).toBe(true);
    expect(isDevServerScriptBody("next dev")).toBe(true);
    expect(isDevServerScriptBody("vue-cli-service serve")).toBe(true);
    expect(isDevServerScriptBody("serve -s dist -l 3000")).toBe(false);
    expect(isDevServerScriptBody("vite preview")).toBe(false);
    expect(isDevServerScriptBody("next start")).toBe(false);
    expect(isDevServerScriptBody("node scripts/dev.mjs")).toBeUndefined();
  });
});
