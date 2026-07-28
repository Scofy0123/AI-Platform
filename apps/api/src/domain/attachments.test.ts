import { describe, expect, test } from "vitest";
import { BasicAttachmentScanner } from "./attachments.js";

describe("BasicAttachmentScanner", () => {
  const scanner = new BasicAttachmentScanner();

  test("accepts a readable text file and normalizes its safe relative path", async () => {
    await expect(
      scanner.scan({
        name: "notes.txt",
        relativePath: "research/notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        content: Buffer.from("hello"),
      }),
    ).resolves.toEqual({
      status: "READY",
      normalizedRelativePath: "research/notes.txt",
    });
  });

  test.each([
    ["../secret.txt", "text/plain", 1, "Unsafe attachment path"],
    ["/etc/passwd", "text/plain", 1, "Unsafe attachment path"],
    ["safe\u0000.txt", "text/plain", 1, "Unsafe attachment path"],
    ["payload.sh", "application/x-sh", 5, "Unsupported executable attachment"],
    ["empty.bin", "application/octet-stream", 0, "Unsupported zero-byte attachment"],
  ])("blocks unsafe attachment %s", async (relativePath, mimeType, sizeBytes, expectedReason) => {
    await expect(
      scanner.scan({
        name: relativePath,
        relativePath,
        mimeType,
        sizeBytes,
        content: Buffer.alloc(sizeBytes),
      }),
    ).resolves.toEqual({
      status: "BLOCKED",
      reason: expectedReason,
    });
  });

  test("blocks files above the 50 MiB per-file limit", async () => {
    await expect(
      scanner.scan({
        name: "large.txt",
        relativePath: "large.txt",
        mimeType: "text/plain",
        sizeBytes: 50 * 1024 * 1024 + 1,
        content: Buffer.alloc(0),
      }),
    ).resolves.toEqual({
      status: "BLOCKED",
      reason: "Attachment exceeds the 50 MiB file limit",
    });
  });
});
