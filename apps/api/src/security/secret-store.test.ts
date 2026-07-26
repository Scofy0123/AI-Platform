import { describe, expect, test } from "vitest";
import { AesGcmSecretStore } from "./secret-store.js";

describe("AesGcmSecretStore", () => {
  const key = Buffer.alloc(32, 7).toString("base64");

  test("round-trips secrets with randomized authenticated encryption", () => {
    const store = new AesGcmSecretStore(key);
    const first = store.encrypt("sentinel-access-token");
    const second = store.encrypt("sentinel-access-token");

    expect(first).not.toBe(second);
    expect(first).not.toContain("sentinel-access-token");
    expect(store.decrypt(first)).toBe("sentinel-access-token");
    expect(store.decrypt(second)).toBe("sentinel-access-token");
  });

  test("rejects malformed keys and tampered ciphertext", () => {
    expect(() => new AesGcmSecretStore(Buffer.alloc(16).toString("base64"))).toThrow(
      "FEISHU_ENCRYPTION_KEY must decode to exactly 32 bytes",
    );

    const store = new AesGcmSecretStore(key);
    const encrypted = store.encrypt("secret");
    const [version, iv, ciphertext, tag] = encrypted.split(".");
    const tamperedTag = Buffer.from(tag ?? "", "base64url");
    tamperedTag[0] = (tamperedTag[0] ?? 0) ^ 1;
    const tampered = [version, iv, ciphertext, tamperedTag.toString("base64url")].join(".");
    expect(() => store.decrypt(tampered)).toThrow();
  });
});
