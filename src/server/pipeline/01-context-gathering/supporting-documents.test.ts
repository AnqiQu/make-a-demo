import { describe, expect, it } from "vitest";

import {
  normalizeSupportingDocument,
  readSupportingDocumentUpload,
} from "./supporting-documents";

describe("Supporting Documents", () => {
  it("accepts document-like uploads and rejects videos and pictures", () => {
    expect(
      readSupportingDocumentUpload({
        artifactId: "artifact_doc",
        fileName: "product-brief.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42_000,
      }),
    ).toEqual({
      artifactId: "artifact_doc",
      fileName: "product-brief.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42_000,
    });

    expect(() =>
      readSupportingDocumentUpload({
        artifactId: "artifact_video",
        fileName: "demo.mp4",
        mimeType: "video/mp4",
        sizeBytes: 42_000,
      }),
    ).toThrowError("Supporting Documents cannot be videos or pictures");
  });

  it("accepts advertised presentation and archive Supporting Document formats", () => {
    expect(
      readSupportingDocumentUpload({
        artifactId: "artifact_deck",
        fileName: "pitch-deck.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        sizeBytes: 42_000,
      }).fileName,
    ).toBe("pitch-deck.pptx");

    expect(
      readSupportingDocumentUpload({
        artifactId: "artifact_archive",
        fileName: "brand-assets.zip",
        mimeType: "application/zip",
        sizeBytes: 42_000,
      }).fileName,
    ).toBe("brand-assets.zip");
  });

  it("normalizes document contents into text artifacts with source metadata", () => {
    const normalized = normalizeSupportingDocument({
      contents:
        "  MakeADemo validates prepared repos.\n\n\nIt generates scripts.  ",
      source: {
        artifactId: "artifact_doc",
        fileName: "brief.md",
        mimeType: "text/markdown",
        sizeBytes: 100,
      },
    });

    expect(normalized).toEqual({
      normalizedText:
        "MakeADemo validates prepared repos.\n\nIt generates scripts.",
      sourceArtifactId: "artifact_doc",
      sourceFileName: "brief.md",
    });
  });
});
