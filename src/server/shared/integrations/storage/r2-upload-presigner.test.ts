import { describe, expect, it } from "vitest";

import {
  createSupportingDocumentUpload,
  storeSupportingDocumentUpload,
} from "./r2-upload-presigner";

describe("createSupportingDocumentUpload", () => {
  it("creates a presigned upload target under uploads with a canonical private R2 url", async () => {
    const result = await createSupportingDocumentUpload(
      {
        draftId: "draft-123",
        fileName: "Product Brief!!.md",
        mimeType: "text/markdown",
        sizeBytes: 1024,
      },
      {
        bucket: "owlet",
        createId: () => "file-123",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignGet: async () => {
          throw new Error("presignGet should not be called");
        },
        presignPut: async (input) => {
          expect(input.bucket).toBe("owlet");
          expect(input.key).toBe("uploads/draft-123/file-123-product-brief.md");
          expect(input.contentType).toBe("text/markdown");
          return `https://uploads.example.test/${input.key}`;
        },
      },
    );

    expect(result).toEqual({
      fileName: "Product Brief!!.md",
      key: "uploads/draft-123/file-123-product-brief.md",
      method: "PUT",
      r2Url: "r2://owlet/uploads/draft-123/file-123-product-brief.md",
      uploadUrl:
        "https://uploads.example.test/uploads/draft-123/file-123-product-brief.md",
    });
  });

  it("rejects images and videos from Supporting Document uploads", async () => {
    await expect(
      createSupportingDocumentUpload(
        {
          draftId: "draft-123",
          fileName: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 1024,
        },
        {
          bucket: "owlet",
          createId: () => "file-123",
          putObject: async () => {
            throw new Error("putObject should not be called");
          },
          presignGet: async () => {
            throw new Error("presignGet should not be called");
          },
          presignPut: async () => "https://uploads.example.test/file",
        },
      ),
    ).rejects.toThrow("Supporting Documents cannot be videos or pictures");
  });

  it("preserves repeated extension text while normalizing only the trailing file extension", async () => {
    const result = await createSupportingDocumentUpload(
      {
        draftId: "draft-123",
        fileName: "Report.pdf Notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      },
      {
        bucket: "owlet",
        createId: () => "file-123",
        putObject: async () => {
          throw new Error("putObject should not be called");
        },
        presignGet: async () => {
          throw new Error("presignGet should not be called");
        },
        presignPut: async (input) => {
          expect(input.key).toBe(
            "uploads/draft-123/file-123-report-pdf-notes.pdf",
          );
          return `https://uploads.example.test/${input.key}`;
        },
      },
    );

    expect(result.key).toBe("uploads/draft-123/file-123-report-pdf-notes.pdf");
  });

  it("stores uploads directly through the server-side storage adapter", async () => {
    const result = await storeSupportingDocumentUpload(
      {
        body: new TextEncoder().encode("hello"),
        draftId: "draft-123",
        fileName: "Product Brief!!.md",
        mimeType: "text/markdown",
        sizeBytes: 5,
      },
      {
        bucket: "owlet",
        createId: () => "file-123",
        putObject: async (input) => {
          expect(input.bucket).toBe("owlet");
          expect(input.key).toBe("uploads/draft-123/file-123-product-brief.md");
          expect(input.contentType).toBe("text/markdown");
          expect(new TextDecoder().decode(input.body)).toBe("hello");
        },
        presignGet: async () => {
          throw new Error("presignGet should not be called");
        },
        presignPut: async () => {
          throw new Error("presignPut should not be called");
        },
      },
    );

    expect(result).toEqual({
      fileName: "Product Brief!!.md",
      key: "uploads/draft-123/file-123-product-brief.md",
      r2Url: "r2://owlet/uploads/draft-123/file-123-product-brief.md",
    });
  });
});
