import type { ExternalResourceManifest } from "./external-resource-manifest.schema";

export const externalResourceReplayRoot =
  "/workspace/.makeademo/external-resources";

/**
 * Generates the backend-owned Playwright policy that permits local traffic,
 * replays exact cached responses, and blocks every remaining external request.
 */
export function createBrowserRuntimeNetworkPolicySource(input: {
  manifest?: ExternalResourceManifest;
  mode: "capture" | "exploration";
  replayRoot?: string;
}): string {
  const replayRoot = input.replayRoot ?? externalResourceReplayRoot;
  const attemptPhase = input.mode === "capture" ? "runtime" : "browser";
  const replayEntries = (input.manifest?.entries ?? []).map((entry) => [
    entry.url,
    {
      contentType: entry.contentType,
      headers: entry.headers,
      path: `${replayRoot}/${entry.relativePath}`,
      status: entry.status,
    },
  ]);
  const reportBlocked =
    input.mode === "exploration"
      ? "result.blockedNetworkAttempts.push(makeADemoAttempt);"
      : 'console.error("[makeademo:network-blocked]", JSON.stringify(makeADemoAttempt));';

  return `const makeADemoAllowedRuntimeOrigin = new URL(baseUrl).origin;
const makeADemoExternalResourceReplay = new Map(${JSON.stringify(replayEntries)});

await context.route("**/*", async (route) => {
  const request = route.request();
  const requestUrl = request.url();
  if (isMakeADemoAllowedRuntimeRequest(requestUrl)) {
    await route.continue();
    return;
  }
  const replay = makeADemoExternalResourceReplay.get(requestUrl);
  if (replay !== undefined) {
    await route.fulfill({
      contentType: replay.contentType,
      headers: replay.headers,
      path: replay.path,
      status: replay.status,
    });
    return;
  }
  const parsedUrl = new URL(requestUrl);
  let headers = {};
  try { headers = await request.allHeaders(); } catch {}
  let initiatorRoute;
  try { initiatorRoute = request.frame().url(); } catch {}
  const makeADemoAttempt = {
    direction: "outbound",
    hasCredentials: Boolean(headers.authorization || headers.cookie),
    host: parsedUrl.host,
    method: request.method(),
    phase: ${JSON.stringify(attemptPhase)},
    resourceType: request.resourceType(),
    ...(initiatorRoute ? { route: initiatorRoute } : {}),
    url: requestUrl,
  };
  ${reportBlocked}
  await route.abort("blockedbyclient");
});

await context.routeWebSocket(/.*/, async (webSocket) => {
  const requestUrl = webSocket.url();
  if (isMakeADemoAllowedRuntimeWebSocket(requestUrl)) {
    webSocket.connectToServer();
    return;
  }
  const parsedUrl = new URL(requestUrl);
  const makeADemoAttempt = {
    direction: "outbound",
    host: parsedUrl.host,
    method: "GET",
    phase: ${JSON.stringify(attemptPhase)},
    resourceType: "websocket",
    url: requestUrl,
  };
  ${reportBlocked}
  await webSocket.close({ code: 1008, reason: "External network access blocked by MakeADemo" });
});

function isMakeADemoAllowedRuntimeRequest(requestUrl) {
  const parsedUrl = new URL(requestUrl);
  if (["about:", "blob:", "data:"].includes(parsedUrl.protocol)) return true;
  return parsedUrl.origin === makeADemoAllowedRuntimeOrigin || isMakeADemoLocalHost(parsedUrl.hostname);
}

function isMakeADemoAllowedRuntimeWebSocket(requestUrl) {
  const parsedUrl = new URL(requestUrl);
  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") return false;
  parsedUrl.protocol = parsedUrl.protocol === "ws:" ? "http:" : "https:";
  return parsedUrl.origin === makeADemoAllowedRuntimeOrigin || isMakeADemoLocalHost(parsedUrl.hostname);
}

function isMakeADemoLocalHost(hostname) {
  return hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0" || hostname.startsWith("127.");
}`;
}
