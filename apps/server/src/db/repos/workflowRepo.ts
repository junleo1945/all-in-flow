import { and, desc, eq } from "drizzle-orm";
import type { WorkflowIR } from "@aif/workflow-ir";
import type { Db } from "../client.js";
import { workflows, workflowVersions } from "../schema/index.js";

export class NotFoundError extends Error {}

/**
 * 为工作流新增一个版本。
 * 事务内对 workflows 行加锁，保证并发生成时版本号连续且不重复（design.md 10.2）。
 */
export async function addVersion(db: Db, userId: number, workflowId: string, ir: WorkflowIR): Promise<number> {
  return db.transaction(async (tx) => {
    const [wf] = await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.userId, userId)))
      .for("update");
    if (!wf) throw new NotFoundError("工作流不存在");

    const version = wf.latestVersion + 1;
    await tx.insert(workflowVersions).values({ workflowId, version, ir });
    await tx
      .update(workflows)
      .set({ latestVersion: version, name: ir.name, updatedAt: new Date() })
      .where(eq(workflows.id, workflowId));
    return version;
  });
}

/** 新建工作流并写入第 1 版 */
export async function createWorkflow(db: Db, userId: number, conversationId: string, ir: WorkflowIR) {
  return db.transaction(async (tx) => {
    const [wf] = await tx
      .insert(workflows)
      .values({ conversationId, userId, name: ir.name, latestVersion: 1 })
      .returning();
    await tx.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, ir });
    return { workflowId: wf!.id, version: 1 };
  });
}

/** 读取工作流（仅限所属用户） */
export async function getWorkflowForUser(db: Db, userId: number, workflowId: string) {
  const [wf] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.userId, userId)));
  if (!wf) throw new NotFoundError("工作流不存在");
  return wf;
}

export async function listVersions(db: Db, workflowId: string) {
  return db
    .select({ version: workflowVersions.version, createdAt: workflowVersions.createdAt })
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, workflowId))
    .orderBy(desc(workflowVersions.version));
}

export async function getVersion(db: Db, workflowId: string, version: number) {
  const [row] = await db
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.version, version)));
  if (!row) throw new NotFoundError("版本不存在");
  return row;
}
