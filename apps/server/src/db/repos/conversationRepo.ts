import { and, asc, desc, eq, isNull, max, sql } from "drizzle-orm";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { Db } from "../client.js";
import { conversations, sessionEntries } from "../schema/index.js";
import { emptyProfile, type Profile } from "../../domain/profile.js";

export class ConversationNotFound extends Error {}

export async function createConversation(db: Db, userId: number, title?: string) {
  const [row] = await db
    .insert(conversations)
    .values({ userId, title: title ?? "新访谈", profile: emptyProfile() })
    .returning();
  return row!;
}

/** 按用户读取会话（不返回已删除的）。越权与不存在统一按不存在处理。 */
export async function getConversation(db: Db, userId: number, id: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId), isNull(conversations.deletedAt)));
  if (!row) throw new ConversationNotFound("会话不存在");
  return row;
}

/** 置顶的排在最前（按置顶时间倒序），其余按最近更新倒序 */
export async function listConversations(db: Db, userId: number) {
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      stage: conversations.stage,
      updatedAt: conversations.updatedAt,
      pinnedAt: conversations.pinnedAt,
    })
    .from(conversations)
    .where(and(eq(conversations.userId, userId), isNull(conversations.deletedAt)))
    .orderBy(sql`${conversations.pinnedAt} desc nulls last`, desc(conversations.updatedAt));
}

export async function softDeleteConversation(db: Db, userId: number, id: string) {
  await getConversation(db, userId, id);
  await db.update(conversations).set({ deletedAt: new Date() }).where(eq(conversations.id, id));
}

/** 修改标题。不改 updatedAt，避免重命名把会话顶到列表最前 */
export async function renameConversation(db: Db, userId: number, id: string, title: string) {
  await getConversation(db, userId, id);
  await db.update(conversations).set({ title }).where(eq(conversations.id, id));
}

/** 置顶或取消置顶；pinned 为 false 时清空置顶时间 */
export async function setPinned(db: Db, userId: number, id: string, pinned: boolean) {
  await getConversation(db, userId, id);
  await db
    .update(conversations)
    .set({ pinnedAt: pinned ? new Date() : null })
    .where(eq(conversations.id, id));
}

export async function saveProfile(db: Db, id: string, profile: Profile, stage?: string) {
  await db
    .update(conversations)
    .set({ profile, updatedAt: new Date(), ...(stage ? { stage } : {}) })
    .where(eq(conversations.id, id));
}

export async function setTitle(db: Db, id: string, title: string) {
  await db.update(conversations).set({ title, updatedAt: new Date() }).where(eq(conversations.id, id));
}

/** 追加一条 Pi 会话条目，seq 由调用方维护（同一会话串行写入） */
export async function appendSessionEntry(db: Db, conversationId: string, seq: number, entry: unknown) {
  await db.insert(sessionEntries).values({ conversationId, seq, entry: entry as object });
}

export async function nextSeq(db: Db, conversationId: string): Promise<number> {
  const [row] = await db
    .select({ m: max(sessionEntries.seq) })
    .from(sessionEntries)
    .where(eq(sessionEntries.conversationId, conversationId));
  return (row?.m ?? -1) + 1;
}

/** 按 seq 读出全部条目，用于恢复 Pi 会话（第一条是 header） */
export async function loadSessionEntries(db: Db, conversationId: string): Promise<FileEntry[]> {
  const rows = await db
    .select({ entry: sessionEntries.entry })
    .from(sessionEntries)
    .where(eq(sessionEntries.conversationId, conversationId))
    .orderBy(asc(sessionEntries.seq));
  return rows.map((r) => r.entry as FileEntry);
}
