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
  const replayEntries = (input.manifest?.entries ?? []).flatMap((entry) => {
    const response = {
      contentType: entry.contentType,
      headers: entry.headers,
      path: `${replayRoot}/${entry.relativePath}`,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      status: entry.status,
    };
    return entry.responseUrl === undefined
      ? [[entry.url, response]]
      : [
          [entry.url, { redirectTo: entry.responseUrl }],
          [entry.responseUrl, response],
        ];
  });
  const reportBlocked =
    input.mode === "exploration"
      ? "result.blockedNetworkAttempts.push(makeADemoAttempt);"
      : 'console.error("[makeademo:network-blocked]", JSON.stringify(makeADemoAttempt));';

  return `const makeADemoAllowedRuntimeOrigin = new URL(baseUrl).origin;
const makeADemoExternalResourceReplay = new Map(${JSON.stringify(replayEntries)});
const makeADemoVerifiedBodies = new Map();

/**
 * Reads a cached body and proves it still matches the manifest before any
 * replay. Submitted code shares the sandbox with the replay root, so bytes
 * verified at upload time are not bytes trusted at request time.
 */
async function makeADemoReadVerifiedReplayBody(replay) {
  const cached = makeADemoVerifiedBodies.get(replay.path);
  if (cached !== undefined) return cached;
  let body;
  try {
    body = await makeADemoReadReplayFile(replay.path);
  } catch {
    return undefined;
  }
  const digest = "sha256:" + makeADemoCreateHash("sha256").update(body).digest("hex");
  if (body.byteLength !== replay.sizeBytes || digest !== replay.sha256) return undefined;
  makeADemoVerifiedBodies.set(replay.path, body);
  return body;
}

await context.route("**/*", async (route) => {
  const request = route.request();
  const requestUrl = request.url();
  let headers = {};
  try { headers = await request.allHeaders(); } catch {}
  if (isMakeADemoAllowedRuntimeRequest(requestUrl)) {
    await route.continue();
    return;
  }
  const parsedUrl = new URL(requestUrl);
  const method = request.method();
  const hasCredentials = Boolean(
    hasMakeADemoUrlCredentials(parsedUrl) ||
    Object.entries(headers).some(
      ([name, value]) =>
        /(?:^|[-_])(?:authorization|cookie|api[-_]?key|auth[-_]?token|security[-_]?token|token)(?:$|[-_])/i.test(name) &&
        String(value || "").length > 0
    )
  );
  const replay = makeADemoExternalResourceReplay.get(requestUrl);
  if (replay !== undefined && method === "GET" && !hasCredentials) {
    if (replay.redirectTo !== undefined) {
      await route.fulfill({
        headers: { location: replay.redirectTo },
        status: 307,
      });
      return;
    }
    const body = await makeADemoReadVerifiedReplayBody(replay);
    if (body !== undefined) {
      const requestedRange = headers.range;
      if (requestedRange && replay.status === 200) {
        const range = readMakeADemoByteRange(requestedRange, body.byteLength);
        if (range === undefined) {
          await route.fulfill({
            headers: { ...replay.headers, "accept-ranges": "bytes", "content-range": "bytes */" + body.byteLength, "x-content-type-options": "nosniff" },
            status: 416,
          });
          return;
        }
        const partialBody = body.subarray(range.start, range.end + 1);
        await route.fulfill({
          body: partialBody,
          contentType: replay.contentType,
          headers: {
            ...replay.headers,
            "accept-ranges": "bytes",
            "content-length": String(partialBody.byteLength),
            "content-range": "bytes " + range.start + "-" + range.end + "/" + body.byteLength,
            "x-content-type-options": "nosniff",
          },
          status: 206,
        });
        return;
      }
      await route.fulfill({
        body,
        contentType: replay.contentType,
        headers: { ...replay.headers, "x-content-type-options": "nosniff" },
        status: replay.status,
      });
      return;
    }
  }
  let initiatorRoute;
  try { initiatorRoute = request.frame().url(); } catch {}
  const makeADemoAttempt = {
    direction: "outbound",
    hasCredentials,
    host: parsedUrl.host,
    method,
    phase: ${JSON.stringify(attemptPhase)},
    resourceType: request.resourceType(),
    ...(initiatorRoute ? { route: initiatorRoute } : {}),
    url: readMakeADemoReportedUrl(parsedUrl),
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
  const hasCredentials = hasMakeADemoUrlCredentials(parsedUrl);
  const makeADemoAttempt = {
    direction: "outbound",
    hasCredentials,
    host: parsedUrl.host,
    method: "GET",
    phase: ${JSON.stringify(attemptPhase)},
    resourceType: "websocket",
    url: readMakeADemoReportedUrl(parsedUrl),
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

function readMakeADemoByteRange(value, size) {
  if (size <= 0 || value.includes(",")) return undefined;
  const match = /^bytes=(\\d*)-(\\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return undefined;
  return { start, end: Math.min(end, size - 1) };
}

const makeADemoCredentialQueryParameter = /^(?:access[_-]?token|api[_-]?key|auth(?:orization)?|credential|password|secret|sig(?:nature)?|token|x-amz-(?:credential|security-token|signature)|x-goog-(?:credential|signature))$/i;

function hasMakeADemoUrlCredentials(url) {
  return Boolean(url.username || url.password || [...url.searchParams.keys()].some((key) => makeADemoCredentialQueryParameter.test(key)));
}

function readMakeADemoReportedUrl(url) {
  const reported = new URL(url);
  reported.username = "";
  reported.password = "";
  for (const key of [...reported.searchParams.keys()]) {
    if (makeADemoCredentialQueryParameter.test(key)) reported.searchParams.set(key, "REDACTED");
  }
  return reported.toString();
}

function isMakeADemoLocalHost(hostname) {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || hostname === "0.0.0.0" || /^127(?:\\.\\d{1,3}){3}$/.test(hostname);
}`;
}
