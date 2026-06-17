import { describe, expect, it } from "vitest";

import { R2SupportingDocumentLoader } from "./r2-supporting-document-loader";

describe("R2SupportingDocumentLoader", () => {
  it("loads text-like Supporting Documents from R2 and normalizes them for the pipeline", async () => {
    const downloads: Array<{ bucket: string; key: string }> = [];
    const loader = new R2SupportingDocumentLoader({
      bucket: "owlet",
      async getObject(input) {
        downloads.push(input);
        return new TextEncoder().encode(
          " Product notes\n\n\nUse dashboard flow. ",
        );
      },
    });

    await expect(
      loader.loadSupportingDocuments([
        {
          fileName: "product.md",
          mimeType: "text/markdown",
          r2Key: "uploads/draft-1/product.md",
          r2Url: "r2://owlet/uploads/draft-1/product.md",
          sizeBytes: 128,
        },
      ]),
    ).resolves.toEqual([
      {
        normalizedText: "Product notes\n\nUse dashboard flow.",
        sourceArtifactId: "r2://owlet/uploads/draft-1/product.md",
        sourceFileName: "product.md",
      },
    ]);
    expect(downloads).toEqual([
      { bucket: "owlet", key: "uploads/draft-1/product.md" },
    ]);
  });
});
