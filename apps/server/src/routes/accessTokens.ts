import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "../http/context.js";
import { AppError, ok } from "../http/envelope.js";
import type { Db } from "../db/client.js";
import type { FixedWindowLimiter } from "../auth/limiter.js";
import {
  countActiveTokens,
  createAccessToken,
  DEFAULT_TTL_DAYS,
  listAccessTokens,
  MAX_ACTIVE_TOKENS,
  MAX_TTL_DAYS,
  revokeAccessToken,
} from "../db/repos/accessTokenRepo.js";
import { tm } from "../i18n.js";

const CreateBody = z.object({
  name: z.string().trim().min(1).max(60),
  expiresInDays: z.number().int().min(1).max(MAX_TTL_DAYS).default(DEFAULT_TTL_DAYS),
});

/**
 * 个人访问令牌管理（需要登录）：生成、查看、撤销。
 * 令牌供用户的本地 Agent 调用平台 MCP（见 routes/mcp.ts）；明文只在创建时返回一次。
 */
export function accessTokenRoutes(deps: { db: Db; limiter: FixedWindowLimiter }) {
  const r = new Hono<{ Variables: AppVariables }>();

  r.get("/", async (c) => ok(c, { max: MAX_ACTIVE_TOKENS, items: await listAccessTokens(deps.db, c.get("user").id) }));

  r.post("/", async (c) => {
    const locale = c.get("locale");
    const userId = c.get("user").id;
    const parsed = CreateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AppError(400, tm(locale, "token.badParams"));
    if (!deps.limiter.hit(`token-create:${userId}`)) throw new AppError(429, tm(locale, "token.tooMany"));
    if ((await countActiveTokens(deps.db, userId)) >= MAX_ACTIVE_TOKENS) {
      throw new AppError(400, tm(locale, "token.limit", { n: MAX_ACTIVE_TOKENS }));
    }
    const { token, info } = await createAccessToken(deps.db, { userId, name: parsed.data.name, ttlDays: parsed.data.expiresInDays });
    return ok(c, { ...info, token }, 201);
  });

  r.delete("/:id", async (c) => {
    const revoked = await revokeAccessToken(deps.db, c.get("user").id, c.req.param("id"));
    if (!revoked) throw new AppError(404, tm(c.get("locale"), "token.notFound"));
    return ok(c, null);
  });

  return r;
}
