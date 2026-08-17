export const repairAdviceKinds = [
  "continue",
  "escalate-hint",
  "directive",
  "stop",
  "spend-bonus-round",
] as const;

/**
 * One bounded strategist recommendation. Consumers must still apply every
 * deterministic gate and may ignore advice whose application floor is not
 * met; no variant grants direct workspace or command authority.
 */
export type RepairAdvice =
  | { kind: "continue" }
  | { hint: string; kind: "escalate-hint" }
  | { directive: string; kind: "directive" }
  | { kind: "stop"; reason: string }
  | { kind: "spend-bonus-round" };

/** Validates the strategist-authored repair-advice artifact. */
export function readRepairAdvice(value: unknown): RepairAdvice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("RepairAdvice must be an object");
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (
    typeof kind !== "string" ||
    !(repairAdviceKinds as readonly string[]).includes(kind)
  ) {
    throw new Error(
      `RepairAdvice.kind must be one of ${repairAdviceKinds.join(", ")}`,
    );
  }

  switch (kind) {
    case "continue":
    case "spend-bonus-round":
      assertOnlyKeys(record, ["kind"]);
      return { kind };
    case "escalate-hint":
      assertOnlyKeys(record, ["hint", "kind"]);
      return { hint: readAdviceText(record.hint, "hint"), kind };
    case "directive":
      assertOnlyKeys(record, ["directive", "kind"]);
      return {
        directive: readAdviceText(record.directive, "directive"),
        kind,
      };
    case "stop":
      assertOnlyKeys(record, ["kind", "reason"]);
      return { kind, reason: readAdviceText(record.reason, "reason") };
  }
  throw new Error("RepairAdvice.kind was not recognized");
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const unknownKey = Object.keys(record).find(
    (key) => !allowedKeys.includes(key),
  );
  if (unknownKey !== undefined) {
    throw new Error(`RepairAdvice.${unknownKey} is not allowed for this kind`);
  }
}

function readAdviceText(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`RepairAdvice.${key} must be a non-empty string`);
  }
  return value.trim();
}
