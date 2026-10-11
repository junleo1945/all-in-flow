import { Hono } from "hono";
import type { AppVariables } from "../http/context.js";
import { AppError, ok } from "../http/envelope.js";
import type { Db } from "../db/client.js";
import { getWorkflowForUser, listVersions, getVersion, NotFoundError } from "../db/repos/workflowRepo.js";
import { workflows } from "../db/schema/index.js";
import { migrateIr } from "@aif/workflow-ir";
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

  return r;
}
