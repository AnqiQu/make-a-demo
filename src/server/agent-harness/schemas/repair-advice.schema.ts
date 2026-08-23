const repairAdviceKinds = [
  "continue",
  "escalate-hint",
  "directive",
  "stop",
  "spend-bonus-round",
] as const;

const memoMaxLength = 1200;

/**
 * One bounded strategist recommendation. Consumers must still apply every
 * deterministic gate and may ignore advice whose application floor is not
 * met; no variant grants direct workspace or command authority. Every kind
 * may carry an optional bounded `memo` — a note persisted across runs of the
 * same repository for the strategist's future consultations; it steers
 * nothing in the current run. Bonus grants require a reason so the round
 * ledger can answer why a run earned an extra round.
 */
export type RepairAdvice =
  | { kind: "continue"; memo?: string }
  | { hint: string; kind: "escalate-hint"; memo?: string }
  | { directive: string; kind: "directive"; memo?: string }
  | { kind: "stop"; memo?: string; reason: string }
  | { kind: "spend-bonus-round"; memo?: string; reason: string };

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

  const memo = readOptionalMemo(record);
  switch (kind) {
    case "continue":
      assertOnlyKeys(record, ["kind", "memo"]);
      return { kind, ...memo };
    case "spend-bonus-round":
      assertOnlyKeys(record, ["kind", "memo", "reason"]);
      return { kind, reason: readAdviceText(record.reason, "reason"), ...memo };
    case "escalate-hint":
      assertOnlyKeys(record, ["hint", "kind", "memo"]);
      return { hint: readAdviceText(record.hint, "hint"), kind, ...memo };
    case "directive":
      assertOnlyKeys(record, ["directive", "kind", "memo"]);
      return {
        directive: readAdviceText(record.directive, "directive"),
        kind,
        ...memo,
      };
    case "stop":
      assertOnlyKeys(record, ["kind", "memo", "reason"]);
      return { kind, reason: readAdviceText(record.reason, "reason"), ...memo };
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

function readOptionalMemo(
  record: Record<string, unknown>,
): { memo: string } | Record<never, never> {
  if (record.memo === undefined) return {};
  const memo = readAdviceText(record.memo, "memo");
  return { memo: memo.slice(0, memoMaxLength) };
}

function readAdviceText(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`RepairAdvice.${key} must be a non-empty string`);
  }
  return value.trim();
}
