import { randomUUID } from "node:crypto";
import { externalResourceManifestVersion } from "../../shared/external-resources/external-resource-manifest.schema";
import type { NetworkAttempt } from "../schemas/artifacts";

export const runtimeNetworkGuardPath =
  "/workspace/.makeademo/runtime-network-guard.cjs";
/**
 * Marker that only the backend-generated guard emits. The nonce keeps a
 * submitted app from fabricating network evidence by printing the marker on
 * its own output — forged attempts would otherwise drive controller-side
 * resource fetches. It lives as long as the process that wrote the guard.
 */
export const runtimeNetworkMarker = `[makeademo:network-blocked:${randomUUID().replaceAll("-", "")}] `;

/** Backend-owned Node/Bun preload that reports and blocks app-server egress. */
export function createRuntimeNetworkGuardSource(): string {
  return String.raw`"use strict";
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const tls = require("node:tls");
const dgram = require("node:dgram");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const marker = ${JSON.stringify(runtimeNetworkMarker)};
const replayRoot = process.env.MAKEADEMO_EXTERNAL_RESOURCE_ROOT || "/workspace/.makeademo/external-resources";
const replayManifestPath = process.env.MAKEADEMO_EXTERNAL_RESOURCE_MANIFEST || path.join(replayRoot, "external-resource-manifest.json");
const replayManifestVersion = ${JSON.stringify(externalResourceManifestVersion)};
let replayEntries;
const replayBodies = new Map();
const credentialQueryParameter = /^(?:access[_-]?token|api[_-]?key|auth(?:orization)?|credential|password|secret|sig(?:nature)?|token|x-amz-(?:credential|security-token|signature)|x-goog-(?:credential|signature))$/i;

function normalizeHost(value) {
  return String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLocal(host) {
  const value = normalizeHost(host);
  return value === "" || value === "localhost" || value === "::1" || value === "0.0.0.0" || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function block(host, url, details) {
  const normalizedHost = normalizeHost(host) || "unknown";
  const reportedUrl = sanitizeUrl(url);
  const attempt = { direction: "outbound", ...(details || {}), host: normalizedHost, phase: "runtime", ...(reportedUrl ? { url: reportedUrl } : {}) };
  process.stderr.write(marker + JSON.stringify(attempt) + "\n");
  const error = new Error("MakeADemo blocked runtime network access to " + (reportedUrl || normalizedHost));
  error.code = "MAKEADEMO_RUNTIME_NETWORK_BLOCKED";
  throw error;
}

function assertAllowed(host, url, details) {
  if (!isLocal(host)) block(host, url, details);
}

function hasCredentialHeaders(...values) {
  for (const value of values) {
    if (!value) continue;
    let entries = [];
    if (typeof value.entries === "function") entries = [...value.entries()];
    else if (Array.isArray(value)) entries = value;
    else if (typeof value === "object") entries = Object.entries(value);
    if (entries.some(([name, header]) => /(?:^|[-_])(?:authorization|cookie|api[-_]?key|auth[-_]?token|security[-_]?token|token)(?:$|[-_])/i.test(String(name)) && String(header || "").length > 0)) return true;
  }
  return false;
}

function hasUrlCredentials(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password || [...url.searchParams.keys()].some((key) => credentialQueryParameter.test(key)));
  } catch {
    return false;
  }
}

function sanitizeUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (credentialQueryParameter.test(key)) url.searchParams.set(key, "REDACTED");
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function readReplay(url) {
  try {
    if (replayEntries === undefined) {
      const manifest = JSON.parse(fs.readFileSync(replayManifestPath, "utf8"));
      replayEntries = new Map();
      if (manifest.version === replayManifestVersion && Array.isArray(manifest.entries)) {
        for (const entry of manifest.entries) {
          if (!entry || typeof entry.url !== "string") continue;
          replayEntries.set(entry.url, entry);
          if (typeof entry.responseUrl === "string") replayEntries.set(entry.responseUrl, entry);
        }
      }
    }
    const entry = replayEntries.get(url);
    if (!entry || !/^resources\/[a-f0-9]{64}$/.test(entry.relativePath) || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256)) return undefined;
    let body = replayBodies.get(entry.relativePath);
    if (body === undefined) {
      body = fs.readFileSync(path.join(replayRoot, entry.relativePath));
      const sha256 = "sha256:" + crypto.createHash("sha256").update(body).digest("hex");
      if (body.byteLength !== entry.sizeBytes || sha256 !== entry.sha256) return undefined;
      replayBodies.set(entry.relativePath, body);
    }
    return { body, entry };
  } catch {
    return undefined;
  }
}

function requestTarget(value, fallbackOptions, defaultProtocol) {
  if (typeof value === "string" || value instanceof URL) {
    try {
      const url = new URL(value);
      return { host: url.hostname, url: url.toString() };
    } catch {}
  }
  const options = value && typeof value === "object" ? value : fallbackOptions;
  if (options && typeof options === "object") {
    try {
      const protocol = options.protocol || defaultProtocol || "http:";
      let hostname = options.hostname || options.host || "localhost";
      if (net.isIP(hostname) === 6) hostname = "[" + hostname + "]";
      const hasPort = hostname.startsWith("[") ? hostname.includes("]:") : hostname.includes(":");
      const authority = options.port && !hasPort ? hostname + ":" + options.port : hostname;
      const url = new URL(options.path || options.pathname || "/", protocol + "//" + authority);
      if (options.auth) {
        const [username, ...password] = String(options.auth).split(":");
        url.username = username;
        url.password = password.join(":");
      }
      return { host: url.hostname, url: url.toString() };
    } catch {}
  }
  return { host: "localhost" };
}

function requestDetails(args, protocol) {
  const first = args[0];
  const second = args[1];
  const options = first && typeof first === "object" && !(first instanceof URL)
    ? first
    : second && typeof second === "object"
      ? second
      : {};
  const target = requestTarget(first, options, protocol);
  const method = String(options.method || "GET").toUpperCase();
  const hasCredentials = Boolean(options.auth) || hasCredentialHeaders(options.headers) || hasUrlCredentials(target.url);
  const callback = findLastFunction(args);
  return { callback, hasCredentials, method, target };
}

function findLastFunction(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (typeof values[index] === "function") return values[index];
  }
  return undefined;
}

function createReplayClientRequest(replay, details) {
  const request = new EventEmitter();
  const requestHeaders = {};
  let ended = false;
  request.destroyed = false;
  if (details.callback) request.once("response", details.callback);
  request.abort = function () { return request.destroy(); };
  request.destroy = function (error) {
    request.destroyed = true;
    if (error) queueMicrotask(() => request.emit("error", error));
    queueMicrotask(() => request.emit("close"));
    return request;
  };
  request.end = function (...args) {
    if (ended || request.destroyed) return request;
    ended = true;
    if (hasCredentialHeaders(requestHeaders)) {
      try {
        block(details.target.host, details.target.url, { hasCredentials: true, method: details.method, resourceType: "fetch" });
      } catch (error) {
        request.destroy(error);
      }
      return request;
    }
    const endCallback = findLastFunction(args);
    queueMicrotask(() => {
      if (request.destroyed) return;
      endCallback?.();
      const response = new PassThrough();
      response.complete = true;
      response.headers = {
        ...replay.entry.headers,
        "content-length": String(replay.body.byteLength),
        "content-type": replay.entry.contentType,
      };
      response.httpVersion = "1.1";
      response.rawHeaders = Object.entries(response.headers).flatMap(([name, value]) => [name, String(value)]);
      response.statusCode = replay.entry.status;
      response.statusMessage = "OK";
      request.emit("response", response);
      response.end(replay.body);
    });
    return request;
  };
  request.flushHeaders = function () {};
  request.getHeader = function (name) { return requestHeaders[String(name).toLowerCase()]; };
  request.getHeaderNames = function () { return Object.keys(requestHeaders); };
  request.getHeaders = function () { return { ...requestHeaders }; };
  request.hasHeader = function (name) { return String(name).toLowerCase() in requestHeaders; };
  request.removeHeader = function (name) { delete requestHeaders[String(name).toLowerCase()]; };
  request.setHeader = function (name, value) { requestHeaders[String(name).toLowerCase()] = value; return request; };
  request.setNoDelay = function () { return request; };
  request.setSocketKeepAlive = function () { return request; };
  request.setTimeout = function () { return request; };
  request.write = function () { return true; };
  return request;
}

function wrapRequest(module, protocol) {
  const originalRequest = module.request;
  module.request = function (...args) {
    const details = requestDetails(args, protocol);
    if (!isLocal(details.target.host)) {
      const replay = details.method === "GET" && !details.hasCredentials && details.target.url ? readReplay(details.target.url) : undefined;
      if (replay) return createReplayClientRequest(replay, details);
      block(details.target.host, details.target.url, { hasCredentials: details.hasCredentials, method: details.method, resourceType: "fetch" });
    }
    return originalRequest.apply(this, args);
  };
  module.get = function (...args) {
    const request = module.request.apply(this, args);
    request.end();
    return request;
  };
}

wrapRequest(http, "http:");
wrapRequest(https, "https:");

function connectionHost(args) {
  const first = args[0];
  if (first && typeof first === "object") return first.path ? "localhost" : first.host || first.hostname || "localhost";
  return typeof args[1] === "string" ? args[1] : "localhost";
}

for (const name of ["connect", "createConnection"]) {
  const original = net[name];
  net[name] = function (...args) {
    assertAllowed(connectionHost(args));
    return original.apply(this, args);
  };
}

const originalTlsConnect = tls.connect;
tls.connect = function (...args) {
  assertAllowed(connectionHost(args));
  return originalTlsConnect.apply(this, args);
};

const originalDgramConnect = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function (...args) {
  assertAllowed(typeof args[1] === "string" ? args[1] : "localhost");
  return originalDgramConnect.apply(this, args);
};

const originalDgramSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  let host = "localhost";
  for (let index = 0; index < args.length - 1; index += 1) {
    if (typeof args[index] === "number" && typeof args[index + 1] === "string") host = args[index + 1];
  }
  assertAllowed(host);
  return originalDgramSend.apply(this, args);
};

if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const target = requestTarget(input && input.url ? input.url : input);
    const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    const hasCredentials = hasCredentialHeaders(input && input.headers, init && init.headers) || hasUrlCredentials(target.url);
    if (!isLocal(target.host)) {
      const replay = method === "GET" && !hasCredentials && target.url ? readReplay(target.url) : undefined;
      if (replay) {
        return Promise.resolve(new Response(replay.body, {
          headers: { ...replay.entry.headers, "content-type": replay.entry.contentType },
          status: replay.entry.status,
        }));
      }
      block(target.host, target.url, { hasCredentials, method, resourceType: "fetch" });
    }
    return originalFetch.call(this, input, init);
  };
}
`;
}

export function readRuntimeNetworkAttempts(output: string): NetworkAttempt[] {
  const attempts = new Map<string, NetworkAttempt>();
  for (const line of output.split("\n")) {
    const markerIndex = line.indexOf(runtimeNetworkMarker);
    if (markerIndex < 0) {
      continue;
    }
    try {
      const value = JSON.parse(
        line.slice(markerIndex + runtimeNetworkMarker.length),
      ) as Record<string, unknown>;
      if (
        value.direction !== "outbound" ||
        value.phase !== "runtime" ||
        typeof value.host !== "string" ||
        value.host.trim().length === 0
      ) {
        continue;
      }
      const attempt: NetworkAttempt = {
        direction: "outbound",
        ...(typeof value.hasCredentials === "boolean"
          ? { hasCredentials: value.hasCredentials }
          : {}),
        host: value.host,
        ...(typeof value.method === "string" ? { method: value.method } : {}),
        phase: "runtime",
        ...(typeof value.resourceType === "string"
          ? { resourceType: value.resourceType }
          : {}),
        ...(typeof value.url === "string" ? { url: value.url } : {}),
      };
      attempts.set(JSON.stringify(attempt), attempt);
    } catch {
      // Malformed application output is not accepted as network evidence.
    }
  }
  return [...attempts.values()];
}
