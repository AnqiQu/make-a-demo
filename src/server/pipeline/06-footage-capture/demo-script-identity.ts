import { createHash } from "node:crypto";
import type { DemoScript } from "./demo-script.schema";

/**
 * Returns the content identity of an accepted Demo Script.
 * Callers must hash the parsed contract value so semantically identical JSON
 * uses one stable identity across Capture and Compositing.
 */
export function createDemoScriptDigest(script: DemoScript): string {
  return `sha256:${createHash("sha256").update(canonicalJson(script)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
