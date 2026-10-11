import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrateIr, validateWorkflow } from "@aif/workflow-ir";
import { createDb, type Db } from "../src/db/client.js";
import { addVersion } from "../src/db/repos/workflowRepo.js";
import { conversations, users, workflows, workflowVersions } from "../src/db/schema/index.js";
import { salesReport, salesReportV1 } from "./fixtures.js";

const url = process.env.DATABASE_URL;
const USER_ID = 990001; // 测试专用，避免与真实 ERP 用户冲突

describe.skipIf(!url)("workflowRepo.addVersion (真实数据库)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let convId: string;
  let wfId: string;

  beforeAll(async () => {
    const c = createDb(url);
    db = c.db;
    close = () => c.sql.end();
    await db.insert(users).values({ id: USER_ID, username: "test-user", displayName: "测试用户" }).onConflictDoNothing();
    const [conv] = await db.insert(conversations).values({ userId: USER_ID }).returning();
    convId = conv!.id;
    const [wf] = await db
      .insert(workflows)
      .values({ conversationId: convId, userId: USER_ID, name: "初始" })
      .returning();
    wfId = wf!.id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(workflowVersions).where(eq(workflowVersions.workflowId, wfId));
    await db.delete(workflows).where(eq(workflows.id, wfId));
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(users).where(eq(users.id, USER_ID));
    await close();
  });

  it("assigns consecutive, unique versions under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => addVersion(db, USER_ID, wfId, salesReport)),
    );
    expect([...results].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const rows = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, wfId));
    expect(rows.length).toBe(8);
    const [wf] = await db.select().from(workflows).where(eq(workflows.id, wfId));
    expect(wf!.latestVersion).toBe(8);
    expect(wf!.name).toBe(salesReport.name);
  });

  it("refuses to add a version for another user's workflow", async () => {
    await expect(addVersion(db, USER_ID + 1, wfId, salesReport)).rejects.toThrow("工作流不存在");
  });

  it("历史 v1 数据原样存取，读取后可以迁移为 v2 并通过校验", async () => {
    await db.insert(workflowVersions).values({ workflowId: wfId, version: 99, ir: salesReportV1 });
    const [row] = await db
      .select()
      .from(workflowVersions)
      .where(and(eq(workflowVersions.workflowId, wfId), eq(workflowVersions.version, 99)));
    expect(row!.ir).toEqual(salesReportV1);
    expect(migrateIr(row!.ir).version).toBe(2);
    expect(validateWorkflow(row!.ir).ok).toBe(true);
  });
});
