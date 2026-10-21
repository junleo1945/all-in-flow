import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseSecretKey } from "../src/auth/secretBox.js";

const KEY = Buffer.alloc(32, 7);

describe("授权信息的加密", () => {
  it("加密后能解开；同一明文每次的密文不同；密文里看不到明文", () => {
    const a = encryptSecret(KEY, "mcp-token-123");
    const b = encryptSecret(KEY, "mcp-token-123");
    expect(a).not.toBe(b);
    expect(a).not.toContain("mcp-token-123");
    expect(decryptSecret(KEY, a)).toBe("mcp-token-123");
  });

  it("密钥不对或密文被改动时解密失败", () => {
    const boxed = encryptSecret(KEY, "token");
    expect(() => decryptSecret(Buffer.alloc(32, 8), boxed)).toThrow();
    const parts = boxed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(KEY, parts.join("."))).toThrow();
    expect(() => decryptSecret(KEY, "garbage")).toThrow();
  });

  it("密钥必须是 32 字节：64 位十六进制或 base64 都可以，其余视为未配置", () => {
    expect(parseSecretKey("a".repeat(64))?.length).toBe(32);
    expect(parseSecretKey(Buffer.alloc(32, 1).toString("base64"))?.length).toBe(32);
    expect(parseSecretKey("too-short")).toBeUndefined();
    expect(parseSecretKey("")).toBeUndefined();
    expect(parseSecretKey(undefined)).toBeUndefined();
  });
});
