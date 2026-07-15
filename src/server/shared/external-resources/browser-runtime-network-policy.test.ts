import { describe, expect, it } from "vitest";
import { createBrowserRuntimeNetworkPolicySource } from "./browser-runtime-network-policy";

describe("createBrowserRuntimeNetworkPolicySource", () => {
  it("passes through only an exact pre-authorized credential-free asset request", async () => {
    let routeHandler: ((route: FakeRoute) => Promise<void>) | undefined;
    const context = {
      async route(
        _pattern: string,
        handler: (route: FakeRoute) => Promise<void>,
      ) {
        routeHandler = handler;
      },
      async routeWebSocket() {},
    };
    const result = { blockedNetworkAttempts: [] as unknown[] };
    const AsyncFunction = Object.getPrototypeOf(async () => undefined)
      .constructor as new (
      ...args: string[]
    ) => (...values: unknown[]) => Promise<void>;
    const installPolicy = new AsyncFunction(
      "context",
      "baseUrl",
      "result",
      createBrowserRuntimeNetworkPolicySource({
        mode: "exploration",
        passthroughUrls: [
          "https://assets.example.com/dashboard.png",
          "https://user:pass@assets.example.com/dashboard.png",
        ],
      }),
    );
    await installPolicy(context, "http://127.0.0.1:3000", result);

    const safe = fakeRoute("https://assets.example.com/dashboard.png");
    await routeHandler?.(safe);
    expect(safe.continued).toBe(true);

    const credentialed = fakeRoute("https://assets.example.com/dashboard.png", {
      cookie: "session=secret",
    });
    await routeHandler?.(credentialed);
    expect(credentialed.aborted).toBe(true);

    const apiKey = fakeRoute("https://assets.example.com/dashboard.png", {
      "x-api-key": "secret",
    });
    await routeHandler?.(apiKey);
    expect(apiKey.aborted).toBe(true);

    const userInfo = fakeRoute(
      "https://user:pass@assets.example.com/dashboard.png",
    );
    await routeHandler?.(userInfo);
    expect(userInfo.aborted).toBe(true);

    const unapproved = fakeRoute("https://assets.example.com/other.png");
    await routeHandler?.(unapproved);
    expect(unapproved.aborted).toBe(true);
    expect(result.blockedNetworkAttempts).toHaveLength(4);
  });
});

type FakeRoute = ReturnType<typeof fakeRoute>;

function fakeRoute(url: string, headers: Record<string, string> = {}) {
  return {
    aborted: false,
    continued: false,
    async abort() {
      this.aborted = true;
    },
    async continue() {
      this.continued = true;
    },
    async fulfill() {},
    request() {
      return {
        async allHeaders() {
          return headers;
        },
        frame() {
          return { url: () => "http://127.0.0.1:3000/" };
        },
        method: () => "GET",
        resourceType: () => "image",
        url: () => url,
      };
    },
  };
}
