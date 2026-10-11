import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { AppVariables } from "../http/context.js";
import { AppError, ok } from "../http/envelope.js";
import { SID_COOKIE } from "../http/context.js";
import { requireUser } from "../http/middleware.js";
import type { AuthService, CurrentUser } from "../auth/service.js";
import type { Db } from "../db/client.js";
import type { AppConfig } from "../config.js";
import { getWorkflowForUser, NotFoundError } from "../db/repos/workflowRepo.js";
import {
  createShare,
  forkShared,
  getOwnedShare,
  listMyShares,
  loadShared,
  recordView,
  revokeShare,
  ShareGone,
  ShareNotFound,
  updateShare,
} from "../db/repos/shareRepo.js";

const CreateBody = z.object({
  version: z.number().int().min(1).nullable().optional(),
  visibility: z.enum(["internal", "public"]).default("internal"),
  expiresInDays: z.union([z.literal(7), z.literal(30), z.null()]).default(30),
  includePainPoints: z.boolean().default(false),
});

const UpdateBody = z.object({
  visibility: z.enum(["internal", "public"]).optional(),
  expiresInDays: z.union([z.literal(7), z.literal(30), z.null()]).optional(),
});

export interface ShareRouteDeps {
  db: Db;
  auth: AuthService;
  config: Pick<AppConfig, "sharePublicEnabled" | "publicBaseUrl">;
}

/** 可选登录：有有效会话则带上用户，否则为 undefined */
async function optionalUser(auth: AuthService, c: { req: { raw: Request }; }, sid: string | undefined) {
  if (!sid) return undefined;
  try {
    return (await auth.verify(sid)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function shareRoutes(deps: ShareRouteDeps) {
  const r = new Hono<{ Variables: AppVariables }>();
  const authed = requireUser(deps.auth);

  const notFound = (e: unknown): never => {
    if (e instanceof NotFoundError || e instanceof ShareNotFound) throw new AppError(404, (e as Error).message);
    throw e;
  };

  // —— 作者侧（需要登录）——
  r.post("/workflows/:id/shares", authed, async (c) => {
    const parsed = CreateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AppError(400, "分享参数不正确");
    const body = parsed.data;
    if (body.visibility === "public" && !deps.config.sharePublicEnabled) {
      throw new AppError(403, "管理员尚未开启公开分享");
    }
    const userId = c.get("user").id;
    const wf = await getWorkflowForUser(deps.db, userId, c.req.param("id")).catch(notFound);
    const version = body.version ?? null;
    if (version !== null && version > wf.latestVersion) throw new AppError(400, "版本不存在");
    const row = await createShare(deps.db, {
      workflowId: wf.id,
      userId,
      version,
      visibility: body.visibility,
      expiresInDays: body.expiresInDays,
      includePainPoints: body.includePainPoints,
    });
    return ok(c, { id: row.id, token: row.token, url: `${deps.config.publicBaseUrl}/s/${row.token}` }, 201);
  });

  r.get("/shares", authed, async (c) => {
    const rows = await listMyShares(deps.db, c.get("user").id);
    return ok(c, rows.map((s) => ({ ...s, url: `${deps.config.publicBaseUrl}/s/${s.token}` })));
  });

  r.patch("/shares/:id", authed, async (c) => {
    const parsed = UpdateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AppError(400, "参数不正确");
    if (parsed.data.visibility === "public" && !deps.config.sharePublicEnabled) {
      throw new AppError(403, "管理员尚未开启公开分享");
    }
    await updateShare(deps.db, c.get("user").id, c.req.param("id"), parsed.data).catch(notFound);
    return ok(c, null);
  });

  r.delete("/shares/:id", authed, async (c) => {
    await revokeShare(deps.db, c.get("user").id, c.req.param("id")).catch(notFound);
    return ok(c, null);
  });

  // —— 访问者侧 ——
  r.get("/s/:token", async (c) => {
    const user = await optionalUser(deps.auth, c, getCookie(c, SID_COOKIE));
    let shared;
    try {
      shared = await loadShared(deps.db, c.req.param("token"));
    } catch (e) {
      if (e instanceof ShareNotFound) throw new AppError(404, "分享不存在");
      if (e instanceof ShareGone) throw new AppError(410, "分享已失效");
      throw e;
    }
    if (shared.share.visibility === "internal" && !user) {
      throw new AppError(401, "请先登录后查看", 40001);
    }
    await recordView(deps.db, shared.share.id);
    return ok(c, {
      name: shared.ir.name,
      owner: shared.ownerName,
      version: shared.version,
      latestVersion: shared.latestVersion,
      updatedAt: shared.updatedAt,
      visibility: shared.share.visibility,
      ir: shared.ir,
      painPoints: shared.painPoints,
      canFork: !!user,
    });
  });

  r.post("/s/:token/fork", authed, async (c) => {
    let shared;
    try {
      shared = await loadShared(deps.db, c.req.param("token"));
    } catch (e) {
      if (e instanceof ShareNotFound) throw new AppError(404, "分享不存在");
      if (e instanceof ShareGone) throw new AppError(410, "分享已失效");
      throw e;
    }
    const created = await forkShared(deps.db, c.get("user").id, {
      shareId: shared.share.id,
      name: shared.ir.name,
      version: shared.version,
      ir: shared.ir,
    });
    return ok(c, created, 201);
  });

  return r;
}

export type { CurrentUser };
export { getOwnedShare };
