import { describe, expect, it } from "vitest";

import { LocalArtifactStore } from "./local-artifact-store";

describe("LocalArtifactStore", () => {
  it("writes, reads, and lists pipeline artifacts", async () => {
    const store = new LocalArtifactStore();

    await store.writeArtifact({
      contents: "validation passed",
      id: "artifact_log",
      kind: "log",
    });

    expect(await store.readArtifact("artifact_log")).toEqual({
      contents: "validation passed",
      id: "artifact_log",
      kind: "log",
    });
    expect(await store.listArtifacts()).toEqual([
      { id: "artifact_log", kind: "log" },
    ]);
  });
});
