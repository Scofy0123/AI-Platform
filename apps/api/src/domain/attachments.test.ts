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
    ["installer.exe", "application/octet-stream", 5, "Unsupported installer attachment"],
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

  test.each([
    ["module.js", "application/javascript", "export const answer = 42;\n"],
    ["script.sh", "application/x-sh", "set -eu\nprintf '%s\\n' safe\n"],
    ["tool.py", "text/x-python", "print('safe')\n"],
  ])(
    "allows ordinary source code without an executable header: %s",
    async (name, mimeType, text) => {
      await expect(
        scanner.scan({
          name,
          relativePath: name,
          mimeType,
          sizeBytes: Buffer.byteLength(text),
          content: Buffer.from(text),
        }),
      ).resolves.toEqual({ status: "READY", normalizedRelativePath: name });
    },
  );

  test.each([
    ["photo.png", "image/png", Buffer.from([0x4d, 0x5a, 0x90, 0x00])],
    ["notes.txt", "text/plain", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02])],
    ["report.pdf", "application/pdf", Buffer.from([0xcf, 0xfa, 0xed, 0xfe])],
    ["readme.md", "text/markdown", Buffer.from("#!/bin/sh\necho unsafe\n")],
    ["installer.txt", "text/plain", Buffer.from("xar!pkg")],
  ])("blocks executable content disguised as %s", async (name, mimeType, content) => {
    await expect(
      scanner.scan({
        name,
        relativePath: name,
        mimeType,
        sizeBytes: content.byteLength,
        content,
      }),
    ).resolves.toEqual({
      status: "BLOCKED",
      reason: "Executable attachment content is not allowed",
    });
  });

  test("blocks a dangerous installer extension even when the MIME is plain text", async () => {
    const content = Buffer.from("not really a package");
    await expect(
      scanner.scan({
        name: "update.pkg",
        relativePath: "update.pkg",
        mimeType: "text/plain",
        sizeBytes: content.byteLength,
        content,
      }),
    ).resolves.toEqual({
      status: "BLOCKED",
      reason: "Unsupported installer attachment",
    });
  });
});
