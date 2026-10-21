import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * 授权信息（如 n8n 的 MCP token）的加密存放：AES-256-GCM，每条记录一个随机 IV。
 * 密钥来自环境变量 AUTH_SECRET_KEY（32 字节，64 位十六进制或 base64）；没有密钥时授权功能关闭。
 * 密文格式：v1.<iv>.<tag>.<cipher>（base64url）。
 */

/** 解析环境变量里的密钥；格式不对时返回 undefined（调用方当作未配置） */
export function parseSecretKey(raw: string | undefined): Buffer | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  return key.length === 32 ? key : undefined;
}

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
}

/** 解密失败（密钥不对、密文被改）时抛出，调用方不应把原因展示给用户 */
export function decryptSecret(key: Buffer, boxed: string): string {
  const [version, iv, tag, data] = boxed.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("密文格式不正确");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
