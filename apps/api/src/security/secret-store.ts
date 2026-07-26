import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SecretStore {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export class AesGcmSecretStore implements SecretStore {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) {
      throw new Error("FEISHU_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      "v1",
      iv.toString("base64url"),
      encrypted.toString("base64url"),
      tag.toString("base64url"),
    ].join(".");
  }

  decrypt(ciphertext: string): string {
    const [version, ivValue, encryptedValue, tagValue, ...rest] = ciphertext.split(".");
    if (version !== "v1" || !ivValue || !encryptedValue || !tagValue || rest.length > 0) {
      throw new Error("Encrypted secret has an invalid envelope");
    }
    const iv = Buffer.from(ivValue, "base64url");
    const encrypted = Buffer.from(encryptedValue, "base64url");
    const tag = Buffer.from(tagValue, "base64url");
    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error("Encrypted secret has invalid AES-GCM parameters");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
}
