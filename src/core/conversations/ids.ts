import { randomUUID } from "node:crypto";

export function createTurnId() {
  return `turn_${randomUUID()}`;
}

export function nowIso() {
  return new Date().toISOString();
}
