import { assertRecord } from "../../../shared/artifact-storage/persisted-record-readers";

export type DemoBrief = {
  audience?: string;
  demoLengthSeconds?: number;
  keyProductFeatures: string[];
  preferredAppDir?: string;
  productSummary?: string;
};

export function readDemoBriefSchema(value: unknown): DemoBrief {
  const record = assertRecord(value, "Demo Brief");
  const keyProductFeatures = readStringArray(record, "keyProductFeatures");
  const audience = record.audience;
  const demoLengthSeconds = record.demoLengthSeconds;
  const preferredAppDir = record.preferredAppDir;
  const productSummary = record.productSummary;

  if (audience !== undefined && typeof audience !== "string") {
    throw new Error("audience must be a string when provided");
  }
  if (
    demoLengthSeconds !== undefined &&
    (typeof demoLengthSeconds !== "number" ||
      !Number.isFinite(demoLengthSeconds) ||
      demoLengthSeconds <= 0)
  ) {
    throw new Error(
      "demoLengthSeconds must be a positive number when provided",
    );
  }
  if (productSummary !== undefined && typeof productSummary !== "string") {
    throw new Error("productSummary must be a string when provided");
  }
  if (
    preferredAppDir !== undefined &&
    (typeof preferredAppDir !== "string" ||
      preferredAppDir.trim().length === 0 ||
      preferredAppDir !== preferredAppDir.trim() ||
      preferredAppDir.startsWith("/") ||
      preferredAppDir.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(preferredAppDir) ||
      preferredAppDir.includes("\0") ||
      preferredAppDir.split(/[\\/]/).includes(".."))
  ) {
    throw new Error(
      "preferredAppDir must be a relative path within the submitted repository",
    );
  }

  return {
    ...(audience === undefined ? {} : { audience }),
    ...(demoLengthSeconds === undefined ? {} : { demoLengthSeconds }),
    keyProductFeatures,
    ...(preferredAppDir === undefined ? {} : { preferredAppDir }),
    ...(productSummary === undefined ? {} : { productSummary }),
  };
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be a string array`);
  }

  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`${key}[${index}] must be a non-empty string`);
    }

    return item;
  });
}
