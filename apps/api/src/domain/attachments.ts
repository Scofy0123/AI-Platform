import { posix } from "node:path";

export const MAX_ATTACHMENT_ROOTS = 32;
export const MAX_ATTACHMENT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TURN_ATTACHMENT_BYTES = 200 * 1024 * 1024;
export const MAX_FOLDER_FILES = 500;

export type AttachmentScanResult =
  | { status: "READY"; normalizedRelativePath: string }
  | { status: "BLOCKED"; reason: string }
  | { status: "FAILED"; reason: string };

export interface AttachmentScanner {
  scan(input: {
    name: string;
    relativePath: string;
    mimeType: string;
    sizeBytes: number;
    content: Buffer;
  }): Promise<AttachmentScanResult>;
}

const INSTALLER_EXTENSIONS = new Set([
  ".app",
  ".bat",
  ".cmd",
  ".com",
  ".cpl",
  ".dll",
  ".dmg",
  ".exe",
  ".hta",
  ".jar",
  ".jse",
  ".msi",
  ".msp",
  ".pkg",
  ".ps1",
  ".scr",
  ".vbe",
  ".vbs",
  ".wsf",
]);

const INSTALLER_MIME_TYPES = new Set([
  "application/java-archive",
  "application/vnd.microsoft.portable-executable",
  "application/x-dosexec",
  "application/x-executable",
  "application/x-msdownload",
]);

const ZERO_BYTE_ALLOWED_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
]);

export class BasicAttachmentScanner implements AttachmentScanner {
  async scan(input: {
    name: string;
    relativePath: string;
    mimeType: string;
    sizeBytes: number;
    content: Buffer;
  }): Promise<AttachmentScanResult> {
    if (input.sizeBytes > MAX_ATTACHMENT_FILE_BYTES) {
      return { status: "BLOCKED", reason: "Attachment exceeds the 50 MiB file limit" };
    }
    if (input.sizeBytes < 0 || input.content.byteLength !== input.sizeBytes) {
      return { status: "FAILED", reason: "Attachment size does not match uploaded content" };
    }
    const normalized = normalizeAttachmentPath(input.relativePath);
    if (!normalized) return { status: "BLOCKED", reason: "Unsafe attachment path" };

    if (input.sizeBytes === 0 && !ZERO_BYTE_ALLOWED_MIME_TYPES.has(input.mimeType.toLowerCase())) {
      return { status: "BLOCKED", reason: "Unsupported zero-byte attachment" };
    }
    const extension = posix.extname(normalized).toLowerCase();
    if (
      INSTALLER_EXTENSIONS.has(extension) ||
      INSTALLER_MIME_TYPES.has(input.mimeType.toLowerCase())
    ) {
      return { status: "BLOCKED", reason: "Unsupported installer attachment" };
    }
    if (hasExecutableSignature(input.content)) {
      return { status: "BLOCKED", reason: "Executable attachment content is not allowed" };
    }
    return { status: "READY", normalizedRelativePath: normalized };
  }
}

function hasExecutableSignature(content: Buffer): boolean {
  if (content.subarray(0, 2).equals(Buffer.from([0x4d, 0x5a]))) return true;
  if (content.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return true;
  if (content.subarray(0, 2).toString("ascii") === "#!") return true;
  if (content.subarray(0, 4).toString("ascii") === "xar!") return true;
  const magic = content.subarray(0, 4).toString("hex");
  return new Set(["cafebabe", "cafebabf", "cefaedfe", "cffaedfe", "feedface", "feedfacf"]).has(
    magic,
  );
}

export function normalizeAttachmentPath(value: string): string | null {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return null;
  }
  if (value.split("/").includes("..")) return null;
  const normalized = posix.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  ) {
    return null;
  }
  return normalized;
}
