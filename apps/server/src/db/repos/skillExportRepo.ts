import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.js";
import { skillExports, type StoredSkillExport } from "../schema/index.js";

/** 每个工作流最多保留的缓存条数：补充不同回答会产生不同的键，不能无限增长 */
export const MAX_CACHED_PER_WORKFLOW = 10;

export async function getCachedSkillExport(db: Db, workflowId: string, cacheKey: string): Promise<{ result: StoredSkillExport; createdAt: Date } | undefined> {
  const [row] = await db
    .select({ result: skillExports.result, createdAt: skillExports.createdAt })
    .from(skillExports)
    .where(and(eq(skillExports.workflowId, workflowId), eq(skillExports.cacheKey, cacheKey)));
  return row;
}

/** 写入（已有同一个键时覆盖，用于「重新生成」），并清掉该工作流最旧的多余条目 */
export async function saveSkillExport(db: Db, workflowId: string, cacheKey: string, result: StoredSkillExport): Promise<void> {
  await db
    .insert(skillExports)
    .values({ workflowId, cacheKey, result })
    .onConflictDoUpdate({ target: [skillExports.workflowId, skillExports.cacheKey], set: { result, createdAt: new Date() } });
  const rows = await db
    .select({ id: skillExports.id })
    .from(skillExports)
    .where(eq(skillExports.workflowId, workflowId))
    .orderBy(desc(skillExports.createdAt))
    .offset(MAX_CACHED_PER_WORKFLOW);
  if (rows.length) await db.delete(skillExports).where(inArray(skillExports.id, rows.map((r) => r.id)));
}
