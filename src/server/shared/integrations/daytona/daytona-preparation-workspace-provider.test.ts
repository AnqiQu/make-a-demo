import { describe, expect, it } from "vitest";

import { DaytonaPreparationWorkspaceProvider } from "./daytona-preparation-workspace-provider";

describe("DaytonaPreparationWorkspaceProvider", () => {
  it("creates a network-blocked Daytona workspace from the configured snapshot", async () => {
    const requests: RecordedRequest[] = [];
    const provider = new DaytonaPreparationWorkspaceProvider({
      apiKey: "daytona_key",
      fetch: fakeFetch(requests, [{ id: "sandbox_123" }]),
      snapshot: "makeademo-opencode",
    });

    const handle = await provider.create();

    expect(handle.id).toBe("sandbox_123");
    expect(requests).toEqual([
      {
        body: {
          disk: 3,
          networkBlockAll: true,
          snapshot: "makeademo-opencode",
        },
        method: "POST",
        url: "https://app.daytona.io/api/sandbox",
      },
    ]);
  });

  it("executes commands through the Daytona toolbox API", async () => {
    const requests: RecordedRequest[] = [];
    const provider = new DaytonaPreparationWorkspaceProvider({
      apiKey: "daytona_key",
      fetch: fakeFetch(requests, [
        { id: "sandbox_123" },
        { exitCode: 0, result: "hello" },
      ]),
    });
    const handle = await provider.create();

    const result = await handle.workspace.execute("echo hello");

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "hello" });
    expect(requests[1]).toEqual({
      body: { command: "echo hello" },
      method: "POST",
      url: "https://proxy.app.daytona.io/toolbox/sandbox_123/process/execute",
    });
  });

  it("updates Daytona outbound network settings and deletes the workspace", async () => {
    const requests: RecordedRequest[] = [];
    const provider = new DaytonaPreparationWorkspaceProvider({
      apiKey: "daytona_key",
      fetch: fakeFetch(requests, [{ id: "sandbox_123" }, {}, {}]),
    });
    const handle = await provider.create();

    await handle.workspace.setOutboundNetworkAccess(false);
    await handle.destroy();

    expect(requests.slice(1)).toEqual([
      {
        body: { networkBlockAll: true },
        method: "POST",
        url: "https://app.daytona.io/api/sandbox/sandbox_123/network-settings",
      },
      {
        body: undefined,
        method: "DELETE",
        url: "https://app.daytona.io/api/sandbox/sandbox_123",
      },
    ]);
  });

  it("reports that file upload needs the Daytona SDK-backed adapter", async () => {
    const provider = new DaytonaPreparationWorkspaceProvider({
      apiKey: "daytona_key",
      fetch: fakeFetch([], [{ id: "sandbox_123" }]),
    });
    const handle = await provider.create();

    await expect(
      handle.workspace.uploadFiles([
        {
          destinationPath: "/workspace/package.json",
          sourcePath: "/tmp/repo/package.json",
        },
      ]),
    ).rejects.toThrow("Daytona file upload requires the SDK-backed adapter.");
  });
});

type RecordedRequest = {
  body: unknown;
  method: string;
  url: string;
};

function fakeFetch(
  requests: RecordedRequest[],
  responses: unknown[],
): typeof fetch {
  return (async (url, init) => {
    requests.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      method: init?.method ?? "GET",
      url: String(url),
    });
    const body = responses.shift() ?? {};

    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;
}
