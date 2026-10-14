import { Hono } from "hono";
import type { AppVariables } from "../http/context.js";
import { AppError, ok } from "../http/envelope.js";
import type { Db } from "../db/client.js";
import { addVersion, getWorkflowForUser, listVersions, getVersion, NotFoundError } from "../db/repos/workflowRepo.js";
import { workflows } from "../db/schema/index.js";
import { migrateIr, validateWorkflow } from "@aif/workflow-ir";
import { findOperation } from "@aif/integrations";
import { desc, eq } from "drizzle-orm";

export function workflowRoutes(deps: { db: Db }) {
  const r = new Hono<{ Variables: AppVariables }>();

  r.get("/", async (c) => {
    const rows = await deps.db
      .select({
        id: workflows.id,
        name: workflows.name,
        latestVersion: workflows.latestVersion,
        conversationId: workflows.conversationId,
        updatedAt: workflows.updatedAt,
      })
      .from(workflows)
      .where(eq(workflows.userId, c.get("user").id))
      .orderBy(desc(workflows.updatedAt));
    return ok(c, rows);
  });

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof NotFoundError) throw new AppError(404, e.message);
      throw e;
    }
  };

  r.get("/:id/versions", async (c) => {
    const userId = c.get("user").id;
    const wf = await guard(() => getWorkflowForUser(deps.db, userId, c.req.param("id")));
    return ok(c, { id: wf.id, name: wf.name, latestVersion: wf.latestVersion, versions: await listVersions(deps.db, wf.id) });
  });

  r.get("/:id/versions/:version", async (c) => {
    const userId = c.get("user").id;
    const wf = await guard(() => getWorkflowForUser(deps.db, userId, c.req.param("id")));
    const version = Number(c.req.param("version"));
    if (!Number.isInteger(version) || version < 1) throw new AppError(400, "版本号无效");
    const row = await guard(() => getVersion(deps.db, wf.id, version));
    return ok(c, { workflowId: wf.id, version: row.version, ir: migrateIr(row.ir), createdAt: row.createdAt });
  });

  /**
   * 保存为新版本：导出前用户补充了判断标准、模板等内容后，写回工作流。
   * 必须通过和生成时相同的校验；版本号由服务端分配，旧版本保持不变。
   */
  r.post("/:id/versions", async (c) => {
    const userId = c.get("user").id;
    const wf = await guard(() => getWorkflowForUser(deps.db, userId, c.req.param("id")));
    const body = (await c.req.json().catch(() => null)) as { ir?: unknown } | null;
    if (!body || typeof body.ir !== "object" || body.ir === null) throw new AppError(400, "缺少工作流内容");
    const result = validateWorkflow(body.ir, { resolveOperation: findOperation });
    if (!result.ok) {
      const errors = result.issues.filter((i) => i.level === "error").map((i) => i.message);
      throw new AppError(400, `工作流校验未通过：${errors.slice(0, 3).join("；")}`);
    }
    const version = await guard(() => addVersion(deps.db, userId, wf.id, result.ir));
    return ok(c, { workflowId: wf.id, version });
  });

  return r;
}
