import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { WorkflowIR } from "@aif/workflow-ir";
import type { Db } from "../client.js";
import { conversations, shares, workflows, workflowVersions } from "../schema/index.js";
import type { Profile } from "../../domain/profile.js";
import { addVersion, getWorkflowForUser } from "./workflowRepo.js";
import { getConversation } from "./conversationRepo.js";
import { createShare } from "./shareRepo.js";

export interface ImportResult {
  conversationId: string;
  workflowId: string;
  version: number;
  /** 分享链接的 token（公司内可见，始终显示最新版本） */
  shareToken: string;
}

/**
 * 取该工作流现有的有效分享（公司内、始终显示最新版本），没有就建一条。
 * 这样同一个工作流多次导入，链接保持不变。
 */
async function ensureShare(db: Db, userId: number, workflowId: string): Promise<string> {
  const now = new Date();
  const [existing] = await db
    .select({ token: shares.token })
    .from(shares)
    .where(
      and(
        eq(shares.workflowId, workflowId),
        eq(shares.userId, userId),
        eq(shares.visibility, "internal"),
        isNull(shares.version),
        isNull(shares.revokedAt),
        or(isNull(shares.expiresAt), gt(shares.expiresAt, now)),
      ),
    )
    .limit(1);
  if (existing) return existing.token;
  const row = await createShare(db, { workflowId, userId, version: null, visibility: "internal", expiresInDays: null, includePainPoints: false });
  return row.token;
}

/**
 * 把本地 Agent 里访谈出的工作流导入平台：新建一个会话（带上画像）、工作流第 1 版和一条分享链接。
 * 会话阶段直接置为 generate；用户在工作台里打开后可以接着对话修改。
 */
export async function importNewWorkflow(db: Db, userId: number, ir: WorkflowIR, profile: Profile): Promise<ImportResult> {
  const created = await db.transaction(async (tx) => {
    const [conv] = await tx
      .insert(conversations)
      .values({
        userId,
        title: `本地导入：${ir.name}`.slice(0, 120),
        stage: "generate",
        profile: { ...profile, importedFrom: { source: "skill" } },
      })
      .returning();
    const [wf] = await tx
      .insert(workflows)
      .values({ conversationId: conv!.id, userId, name: ir.name, latestVersion: 1 })
      .returning();
    await tx.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, ir });
    return { conversationId: conv!.id, workflowId: wf!.id };
  });
  const shareToken = await ensureShare(db, userId, created.workflowId);
  return { ...created, version: 1, shareToken };
}

/** 给已导入（或在网站上创建）的工作流新增一个版本；工作流或其会话不属于该用户、或会话已删除时抛出 NotFoundError / ConversationNotFound */
export async function importNewVersion(db: Db, userId: number, workflowId: string, ir: WorkflowIR): Promise<ImportResult> {
  const wf = await getWorkflowForUser(db, userId, workflowId);
  await getConversation(db, userId, wf.conversationId);
  const version = await addVersion(db, userId, workflowId, ir);
  const shareToken = await ensureShare(db, userId, workflowId);
  return { conversationId: wf.conversationId, workflowId, version, shareToken };
}
