import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { Db } from "../client.js";
import { accessTokens, users } from "../schema/index.js";

/** 令牌统一以此开头，方便用户和密钥扫描工具认出它 */
export const TOKEN_PREFIX = "aif_";
/** 每个用户同时有效的令牌上限 */
export const MAX_ACTIVE_TOKENS = 5;
export const DEFAULT_TTL_DAYS = 90;
export const MAX_TTL_DAYS = 365;
/** 最近使用时间最多每分钟写一次，避免每次调用都写库 */
const TOUCH_INTERVAL_MS = 60_000;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** 列表里的一项：不含令牌本身 */
export interface AccessTokenInfo {
  id: string;
  name: string;
  /** 令牌开头的几位（含 aif_ 前缀），用于辨认 */
  prefix: string;
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
}

const info = (r: typeof accessTokens.$inferSelect): AccessTokenInfo => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  expiresAt: r.expiresAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

const active = (now: Date) => and(isNull(accessTokens.revokedAt), gt(accessTokens.expiresAt, now));

export async function countActiveTokens(db: Db, userId: number, now = new Date()): Promise<number> {
  const [row] = await db.select({ n: count() }).from(accessTokens).where(and(eq(accessTokens.userId, userId), active(now)));
  return row?.n ?? 0;
}

/** 列出还有效的令牌（已撤销、已过期的不列出） */
export async function listAccessTokens(db: Db, userId: number, now = new Date()): Promise<AccessTokenInfo[]> {
  const rows = await db
    .select()
    .from(accessTokens)
    .where(and(eq(accessTokens.userId, userId), active(now)))
    .orderBy(desc(accessTokens.createdAt));
  return rows.map(info);
}

/** 创建令牌。返回的 token 是明文，之后再也取不到 */
export async function createAccessToken(
  db: Db,
  input: { userId: number; name: string; ttlDays: number },
  now = new Date(),
): Promise<{ token: string; info: AccessTokenInfo }> {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(accessTokens)
    .values({
      userId: input.userId,
      name: input.name,
      tokenHash: hashToken(token),
      prefix: token.slice(0, TOKEN_PREFIX.length + 4),
      expiresAt: new Date(now.getTime() + input.ttlDays * 86400_000),
    })
    .returning();
  return { token, info: info(row!) };
}

/** 撤销令牌；只限本人，返回是否撤销了一条有效令牌 */
export async function revokeAccessToken(db: Db, userId: number, id: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(accessTokens)
    .set({ revokedAt: now })
    .where(and(eq(accessTokens.id, id), eq(accessTokens.userId, userId), isNull(accessTokens.revokedAt)))
    .returning({ id: accessTokens.id });
  return rows.length > 0;
}

export interface TokenUser {
  id: number;
  username: string;
  displayName: string;
  tokenId: string;
}

/** 校验令牌，返回它所属的用户；令牌不存在、已撤销或已过期时返回 null */
export async function authenticateToken(db: Db, token: string, now = new Date()): Promise<TokenUser | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const [row] = await db
    .select({ token: accessTokens, user: users })
    .from(accessTokens)
    .innerJoin(users, eq(users.id, accessTokens.userId))
    .where(and(eq(accessTokens.tokenHash, hashToken(token)), active(now)));
  if (!row) return null;

  const last = row.token.lastUsedAt;
  if (!last || now.getTime() - last.getTime() > TOUCH_INTERVAL_MS) {
    await db.update(accessTokens).set({ lastUsedAt: now }).where(eq(accessTokens.id, row.token.id));
  }
  return { id: row.user.id, username: row.user.username, displayName: row.user.displayName, tokenId: row.token.id };
}

/** 清理早已过期或撤销的令牌，可定时调用 */
export async function purgeDeadTokens(db: Db, olderThanDays = 30, now = new Date()) {
  const cutoff = new Date(now.getTime() - olderThanDays * 86400_000);
  await db.delete(accessTokens).where(or(lt(accessTokens.expiresAt, cutoff), lt(accessTokens.revokedAt, cutoff)));
}
