import { createInterface } from "node:readline/promises";

export function createCliReadline() {
  return createInterface({ input: process.stdin, output: process.stdout });
}
