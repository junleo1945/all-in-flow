import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { AppVariables } from "../http/context.js";
import { AppError, ok } from "../http/envelope.js";
import type { Db } from "../db/client.js";
import { usageDaily, users } from "../db/schema/index.js";
import { today, todayTotalCost } from "../agent/quota.js";
import { requireUser } from "../http/middleware.js";
import type { AuthService } from "../auth/service.js";

/** 管理员：当日用量（design.md 9.1 GET /api/admin/usage） */
export function adminRoutes(deps: { db: Db; auth: AuthService; dailyCostLimitUsd: number }) {
  const r = new Hono<{ Variables: AppVariables }>();
  r.use("/*", requireUser(deps.auth));
  r.use("/*", async (c, next) => {
    if (!c.get("user").isAdmin) throw new AppError(403, "需要管理员权限");
    await next();
  });

  r.get("/usage", async (c) => {
    const day = today();
    const rows = await deps.db
      .select({
        userId: usageDaily.userId,
        username: users.username,
        displayName: users.displayName,
        inputTokens: usageDaily.inputTokens,
        outputTokens: usageDaily.outputTokens,
        costUsd: usageDaily.costUsd,
      })
      .from(usageDaily)
      .innerJoin(users, sql`${users.id} = ${usageDaily.userId}`)
      .where(sql`${usageDaily.day} = ${day}`)
      .orderBy(sql`${usageDaily.costUsd} desc`);
    const total = await todayTotalCost(deps.db, day);
    return ok(c, { day, totalCostUsd: total, dailyCostLimitUsd: deps.dailyCostLimitUsd, users: rows });
  });

  return r;
}
