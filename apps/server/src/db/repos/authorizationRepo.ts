import { and, count, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { authorizations } from "../schema/index.js";

export type AuthorizationKind = "mcp";

/** 列表里的一项：不含密文 */
export interface AuthorizationInfo {
  id: string;
  kind: AuthorizationKind;
  name: string;
  url: string;
  createdAt: string;
}

const info = (r: typeof authorizations.$inferSelect): AuthorizationInfo => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  url: r.url,
  createdAt: r.createdAt.toISOString(),
});

export async function listAuthorizations(db: Db, userId: number): Promise<AuthorizationInfo[]> {
  const rows = await db.select().from(authorizations).where(eq(authorizations.userId, userId)).orderBy(authorizations.createdAt);
  return rows.map(info);
}

export async function countAuthorizations(db: Db, userId: number): Promise<number> {
  const [row] = await db.select({ n: count() }).from(authorizations).where(eq(authorizations.userId, userId));
  return row?.n ?? 0;
}

export async function createAuthorization(
  db: Db,
  input: { userId: number; kind: AuthorizationKind; name: string; url: string; secret: string },
): Promise<AuthorizationInfo> {
  const [row] = await db.insert(authorizations).values(input).returning();
  return info(row!);
}

/** 取出一条授权（含密文）；只限本人 */
export async function getAuthorizationWithSecret(db: Db, userId: number, id: string) {
  const [row] = await db.select().from(authorizations).where(and(eq(authorizations.userId, userId), eq(authorizations.id, id)));
  return row;
}

export async function renameAuthorization(db: Db, userId: number, id: string, name: string): Promise<AuthorizationInfo | undefined> {
  const [row] = await db.update(authorizations).set({ name }).where(and(eq(authorizations.userId, userId), eq(authorizations.id, id))).returning();
  return row ? info(row) : undefined;
}

export async function deleteAuthorization(db: Db, userId: number, id: string): Promise<boolean> {
  const rows = await db.delete(authorizations).where(and(eq(authorizations.userId, userId), eq(authorizations.id, id))).returning({ id: authorizations.id });
  return rows.length > 0;
}
