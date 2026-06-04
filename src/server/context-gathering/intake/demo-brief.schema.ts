export type DemoBrief = {
  audience?: string;
  keyProductFeatures: string[];
};

export function readDemoBriefSchema(value: unknown): DemoBrief {
  const record = assertRecord(value, "Demo Brief");
  const keyProductFeatures = readNonEmptyStringArray(
    record,
    "keyProductFeatures",
  );
  const audience = record.audience;

  if (audience !== undefined && typeof audience !== "string") {
    throw new Error("audience must be a string when provided");
  }

  return audience === undefined
    ? { keyProductFeatures }
    : { audience, keyProductFeatures };
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readNonEmptyStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} must be a non-empty string array`);
  }

  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`${key}[${index}] must be a non-empty string`);
    }

    return item;
  });
}
