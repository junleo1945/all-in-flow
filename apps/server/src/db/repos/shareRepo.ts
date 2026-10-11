import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { migrateIr, type WorkflowIR } from "@aif/workflow-ir";
import type { Db } from "../client.js";
import { shares, workflows, workflowVersions, conversations, users } from "../schema/index.js";

export class ShareNotFound extends Error {}
export class ShareGone extends Error {}

export const newToken = () => randomBytes(16).toString("base64url"); // 22 位

export interface CreateShareInput {
  workflowId: string;
  userId: number;
  version: number | null;
  visibility: "internal" | "public";
  expiresInDays: number | null;
  includePainPoints: boolean;
}

export async function createShare(db: Db, input: CreateShareInput) {
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000) : null;
  const [row] = await db
    .insert(shares)
    .values({
      token: newToken(),
      workflowId: input.workflowId,
      userId: input.userId,
      version: input.version,
      visibility: input.visibility,
      includePainPoints: input.includePainPoints,
      expiresAt,
    })
    .returning();
  return row!;
}

export async function listMyShares(db: Db, userId: number) {
  return db
    .select({
      id: shares.id,
      token: shares.token,
      workflowId: shares.workflowId,
      workflowName: workflows.name,
      version: shares.version,
      visibility: shares.visibility,
      expiresAt: shares.expiresAt,
      revokedAt: shares.revokedAt,
      viewCount: shares.viewCount,
      createdAt: shares.createdAt,
    })
    .from(shares)
    .innerJoin(workflows, eq(workflows.id, shares.workflowId))
    .where(eq(shares.userId, userId))
    .orderBy(desc(shares.createdAt));
}

export async function getOwnedShare(db: Db, userId: number, id: string) {
  const [row] = await db.select().from(shares).where(and(eq(shares.id, id), eq(shares.userId, userId)));
  if (!row) throw new ShareNotFound("分享不存在");
  return row;
}

export async function updateShare(db: Db, userId: number, id: string, patch: { visibility?: "internal" | "public"; expiresInDays?: number | null }) {
  await getOwnedShare(db, userId, id);
  const set: Record<string, unknown> = {};
  if (patch.visibility) set.visibility = patch.visibility;
  if (patch.expiresInDays !== undefined) {
    set.expiresAt = patch.expiresInDays ? new Date(Date.now() + patch.expiresInDays * 86400_000) : null;
  }
  if (Object.keys(set).length) await db.update(shares).set(set).where(eq(shares.id, id));
}

export async function revokeShare(db: Db, userId: number, id: string) {
  await getOwnedShare(db, userId, id);
  await db.update(shares).set({ revokedAt: new Date() }).where(eq(shares.id, id));
}

/**
 * 读取分享内容。撤销、过期、所属会话被删除统一视为失效（ShareGone）。
 * 返回值不包含对话记录。
 */
export async function loadShared(db: Db, token: string) {
  const [row] = await db
    .select({
      share: shares,
      workflow: workflows,
      conversation: conversations,
      ownerName: users.displayName,
    })
    .from(shares)
    .innerJoin(workflows, eq(workflows.id, shares.workflowId))
    .innerJoin(conversations, eq(conversations.id, workflows.conversationId))
    .innerJoin(users, eq(users.id, shares.userId))
    .where(eq(shares.token, token));
  if (!row) throw new ShareNotFound("分享不存在");

  const s = row.share;
  const gone = s.revokedAt || (s.expiresAt && s.expiresAt.getTime() < Date.now()) || row.conversation.deletedAt;
  if (gone) throw new ShareGone("分享已失效");

  const version = s.version ?? row.workflow.latestVersion;
  const [v] = await db
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.workflowId, row.workflow.id), eq(workflowVersions.version, version)));
  if (!v) throw new ShareNotFound("版本不存在");

  const ir = migrateIr(v.ir);
  return {
    share: s,
    ownerName: row.ownerName,
    workflowId: row.workflow.id,
    version,
    latestVersion: row.workflow.latestVersion,
    updatedAt: row.workflow.updatedAt,
    ir,
    painPoints: s.includePainPoints
      ? ((row.conversation.profile as any)?.painPoints ?? []).filter((p: any) => (ir.source?.painPointIds ?? []).includes(p.id))
      : undefined,
  };
}

/** 原子自增访问次数 */
export async function recordView(db: Db, shareId: string) {
  await db
    .update(shares)
    .set({ viewCount: sql`${shares.viewCount} + 1`, lastViewedAt: new Date() })
    .where(eq(shares.id, shareId));
}

/** 复制分享的工作流到用户自己的工作台：新建会话 + 工作流第 1 版 */
export async function forkShared(
  db: Db,
  userId: number,
  shared: { shareId: string; name: string; version: number; ir: WorkflowIR },
) {
  return db.transaction(async (tx) => {
    const [conv] = await tx
      .insert(conversations)
      .values({
        userId,
        title: `来自分享：${shared.name}`,
        stage: "generate",
        profile: { role: { systems: [] }, tasks: [], painPoints: [], candidates: [], importedFrom: { shareId: shared.shareId, name: shared.name, version: shared.version } },
      })
      .returning();
    const [wf] = await tx
      .insert(workflows)
      .values({ conversationId: conv!.id, userId, name: shared.ir.name, latestVersion: 1, forkedFromShareId: shared.shareId })
      .returning();
    await tx.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, ir: shared.ir });
    return { conversationId: conv!.id, workflowId: wf!.id };
  });
}

