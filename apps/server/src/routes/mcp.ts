import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Db } from "../db/client.js";
import { authenticateToken } from "../db/repos/accessTokenRepo.js";
import { handleMessage, RPC_INVALID_REQUEST, RPC_PARSE_ERROR, rpcError, type RpcResponse, type ServerInfo } from "../mcp/protocol.js";
import { createMcpTools, type McpToolDeps } from "../mcp/tools.js";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_BATCH = 20;

const INSTRUCTIONS =
  "All-in-Flow 平台。用 validate_workflow 校验访谈得出的工作流（Workflow IR v2），用 import_workflow 导入并拿到流程图页面链接，把链接交给用户查看。";

/**
 * 平台的 MCP 端点（Streamable HTTP，无状态）：用户的本地 Agent 用个人访问令牌调用，
 * 校验并导入访谈得出的工作流，拿到画布渲染的流程图链接。
 * 认证只认 Authorization: Bearer <令牌>，不读 cookie，所以不受跨站请求影响。
 */
export function mcpRoutes(deps: McpToolDeps & { version?: string }) {
  const r = new Hono();
  const tools = createMcpTools(deps);
  const info: ServerInfo = { name: "all-in-flow", version: deps.version ?? "0.1.0", instructions: INSTRUCTIONS };

  r.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(rpcError(null, RPC_INVALID_REQUEST, "请求内容过大"), 413),
    }),
  );

  r.post("/", async (c) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    const user = bearer ? await authenticateToken(deps.db, bearer) : null;
    if (!user) {
      return c.json(rpcError(null, -32001, "访问令牌无效、已过期或已撤销。请在 All-in-Flow 网站重新生成令牌。"), 401, {
        "WWW-Authenticate": 'Bearer realm="all-in-flow"',
      });
    }

    const body = await c.req.json().catch(() => undefined);
    if (body === undefined) return c.json(rpcError(null, RPC_PARSE_ERROR, "请求不是合法的 JSON"), 400);

    const run = (m: unknown) => handleMessage(m, { info, tools, ctx: { user } });

    if (Array.isArray(body)) {
      if (body.length === 0 || body.length > MAX_BATCH) return c.json(rpcError(null, RPC_INVALID_REQUEST, `批量请求需要 1 到 ${MAX_BATCH} 条消息`), 400);
      const out = (await Promise.all(body.map(run))).filter((x): x is RpcResponse => x !== null);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const res = await run(body);
    return res ? c.json(res) : c.body(null, 202);
  });

  // 无状态服务：不提供服务端推送流，也没有会话可以结束
  const notAllowed = (c: import("hono").Context) => c.body(null, 405, { Allow: "POST" });
  r.get("/", notAllowed);
  r.delete("/", notAllowed);

  return r;
}
