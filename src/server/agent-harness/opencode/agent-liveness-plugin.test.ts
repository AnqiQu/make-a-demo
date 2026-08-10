import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentLivenessBeatIntervalMs,
  agentLivenessMarker,
  createAgentLivenessPluginSource,
} from "./agent-liveness-plugin";

type AgentLivenessHooks = {
  event: (input: { event: { type: string } }) => Promise<void>;
};

async function createPluginHooks(
  options: { beatIntervalMs?: number } = {},
): Promise<AgentLivenessHooks> {
  const source = createAgentLivenessPluginSource(options);
  const module = (await import(
    `data:text/javascript,${encodeURIComponent(source)}`
  )) as {
    AgentLivenessPlugin: (
      input: Record<string, never>,
    ) => Promise<AgentLivenessHooks>;
  };
  return module.AgentLivenessPlugin({});
}

function spyOnStderr() {
  return vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true) as unknown as {
    mock: { calls: unknown[][] };
  };
}

describe("agent-liveness plugin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults the beat interval well under the inactivity window", () => {
    expect(agentLivenessBeatIntervalMs).toBeLessThan(60_000);
    expect(createAgentLivenessPluginSource()).toContain(
      String(agentLivenessBeatIntervalMs),
    );
  });

  it("beats once to stderr on the first model bus event", async () => {
    const stderr = spyOnStderr();
    const hooks = await createPluginHooks();

    await hooks.event({ event: { type: "message.part.updated" } });

    expect(stderr.mock.calls).toHaveLength(1);
    const line = String(stderr.mock.calls[0]?.[0]);
    expect(line.startsWith(agentLivenessMarker)).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
  });

  it("throttles beats inside the interval and resumes after it elapses", async () => {
    // The plugin runs inside OpenCode with no injectable clock, so the
    // throttle is proven with a short real interval instead of fake timers
    // (the data:-URL module loads outside vitest's mocked globals anyway).
    const stderr = spyOnStderr();
    const hooks = await createPluginHooks({ beatIntervalMs: 40 });

    await hooks.event({ event: { type: "message.part.updated" } });
    await hooks.event({ event: { type: "message.part.updated" } });
    await hooks.event({ event: { type: "session.idle" } });
    expect(stderr.mock.calls).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 60));
    await hooks.event({ event: { type: "message.part.updated" } });
    expect(stderr.mock.calls).toHaveLength(2);
  });

  it("gives each plugin instance its own throttle so a new session beats immediately", async () => {
    const stderr = spyOnStderr();
    const first = await createPluginHooks();
    const second = await createPluginHooks();

    await first.event({ event: { type: "message.part.updated" } });
    await second.event({ event: { type: "message.part.updated" } });

    expect(stderr.mock.calls).toHaveLength(2);
  });

  it("stays harmless when the stderr write itself fails", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("EPIPE");
    });
    const hooks = await createPluginHooks();

    await expect(
      hooks.event({ event: { type: "message.part.updated" } }),
    ).resolves.toBeUndefined();
  });
});
