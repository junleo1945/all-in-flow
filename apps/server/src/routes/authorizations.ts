import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "../http/context.js";
import { AppError, ok } from "../http/envelope.js";
import type { Db } from "../db/client.js";
import type { FixedWindowLimiter } from "../auth/limiter.js";
import { decryptSecret, encryptSecret } from "../auth/secretBox.js";
import {
  countAuthorizations,
  createAuthorization,
  deleteAuthorization,
  getAuthorizationWithSecret,
  listAuthorizations,
  renameAuthorization,
} from "../db/repos/authorizationRepo.js";
import { McpError, normalizeMcpUrl, withMcp, type McpDeps } from "../n8n/mcp.js";

/** 每个用户最多保存的授权数 */
export const MAX_AUTHORIZATIONS = 10;

const CreateBody = z.object({
  kind: z.literal("mcp"),
  name: z.string().trim().min(1).max(60),
  url: z.string().min(8).max(2048),
  secret: z.string().min(1).max(4096),
});
const RenameBody = z.object({ name: z.string().trim().min(1).max(60) });

/** 读取一条授权并解密，返回地址与 token；找不到或解密失败时抛出（不泄漏原因） */
export async function loadAuthorization(db: Db, key: Buffer, userId: number, id: string): Promise<{ url: string; token: string; name: string }> {
  const row = await getAuthorizationWithSecret(db, userId, id);
  if (!row) throw new AppError(404, "授权不存在");
  try {
    return { url: row.url, token: decryptSecret(key, row.secret), name: row.name };
  } catch {
    throw new AppError(500, "授权信息无法读取，请删除后重新添加");
  }
}

/**
 * 授权管理（MCP 服务）：用户保存自己的 MCP 服务地址和 token（导出 n8n 用的是 n8n 的 MCP）。
 * 保存前先连一次验证；token 加密存放，任何接口都不返回它。
 */
export function authorizationRoutes(deps: { db: Db; secretKey?: Buffer; limiter: FixedWindowLimiter; mcp?: McpDeps }) {
  const r = new Hono<{ Variables: AppVariables }>();

  const needKey = (): Buffer => {
    if (!deps.secretKey) throw new AppError(503, "授权管理未启用：服务端没有配置 AUTH_SECRET_KEY");
    return deps.secretKey;
  };
  const fromMcp = (e: unknown): never => {
    if (e instanceof McpError) throw new AppError(e.status, e.message);
    throw e;
  };

  r.get("/", async (c) => ok(c, { enabled: !!deps.secretKey, items: await listAuthorizations(deps.db, c.get("user").id) }));

  r.post("/", async (c) => {
    const key = needKey();
    const userId = c.get("user").id;
    if (!deps.limiter.hit(`authz:${userId}`)) throw new AppError(429, "操作太频繁，请稍后再试");
    const parsed = CreateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "请填写名称、MCP 地址和 token");
    if ((await countAuthorizations(deps.db, userId)) >= MAX_AUTHORIZATIONS) throw new AppError(400, `最多保存 ${MAX_AUTHORIZATIONS} 个授权`);
    try {
      const url = normalizeMcpUrl(parsed.data.url);
      // 先连一次：地址不可达、token 不对、没开 MCP，都不保存
      await withMcp(url, parsed.data.secret, deps.mcp ?? {}, (s) => s.availableTools());
      const item = await createAuthorization(deps.db, { userId, kind: parsed.data.kind, name: parsed.data.name, url, secret: encryptSecret(key, parsed.data.secret.trim()) });
      return ok(c, item);
    } catch (e) {
      return fromMcp(e);
    }
  });

  r.patch("/:id", async (c) => {
    const parsed = RenameBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "请填写名称");
    const item = await renameAuthorization(deps.db, c.get("user").id, c.req.param("id"), parsed.data.name);
    if (!item) throw new AppError(404, "授权不存在");
    return ok(c, item);
  });

  r.delete("/:id", async (c) => {
    if (!(await deleteAuthorization(deps.db, c.get("user").id, c.req.param("id")))) throw new AppError(404, "授权不存在");
    return ok(c, null);
  });

  return r;
}
