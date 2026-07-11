import type { NetworkAttempt } from "../schemas/artifacts";

export const runtimeNetworkGuardPath =
  "/workspace/.makeademo/runtime-network-guard.cjs";
export const runtimeNetworkMarker = "[makeademo:network-blocked] ";

/** Backend-owned Node/Bun preload that reports and blocks app-server egress. */
export function createRuntimeNetworkGuardSource(): string {
  return String.raw`"use strict";
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const dgram = require("node:dgram");
const marker = ${JSON.stringify(runtimeNetworkMarker)};
const allowed = new Set((process.env.MAKEADEMO_ALLOWED_RUNTIME_HOSTS || "").split(",").map((value) => normalizeHost(value)).filter(Boolean));

function normalizeHost(value) {
  return String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLocal(host) {
  const value = normalizeHost(host);
  return value === "" || value === "localhost" || value === "::1" || value === "0.0.0.0" || value.startsWith("127.") || allowed.has(value);
}

function block(host, url) {
  const normalizedHost = normalizeHost(host) || "unknown";
  const attempt = { direction: "outbound", host: normalizedHost, phase: "runtime", ...(url ? { url: String(url) } : {}) };
  process.stderr.write(marker + JSON.stringify(attempt) + "\n");
  const error = new Error("MakeADemo blocked runtime network access to " + (url || normalizedHost));
  error.code = "MAKEADEMO_RUNTIME_NETWORK_BLOCKED";
  throw error;
}

function assertAllowed(host, url) {
  if (!isLocal(host)) block(host, url);
}

function requestTarget(value) {
  if (typeof value === "string" || value instanceof URL) {
    try {
      const url = new URL(value);
      return { host: url.hostname, url: url.toString() };
    } catch {}
  }
  if (value && typeof value === "object") {
    return { host: value.hostname || value.host || "localhost", url: value.href };
  }
  return { host: "localhost" };
}

function wrapRequest(module) {
  const originalRequest = module.request;
  const originalGet = module.get;
  module.request = function (...args) {
    const target = requestTarget(args[0]);
    assertAllowed(target.host, target.url);
    return originalRequest.apply(this, args);
  };
  module.get = function (...args) {
    const target = requestTarget(args[0]);
    assertAllowed(target.host, target.url);
    return originalGet.apply(this, args);
  };
}

wrapRequest(http);
wrapRequest(https);

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
    assertAllowed(target.host, target.url);
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
        host: value.host,
        phase: "runtime",
        ...(typeof value.url === "string" ? { url: value.url } : {}),
      };
      attempts.set(JSON.stringify(attempt), attempt);
    } catch {
      // Malformed application output is not accepted as network evidence.
    }
  }
  return [...attempts.values()];
}
