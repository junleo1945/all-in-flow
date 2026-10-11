import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "../http/context.js";
import { AppError, ok } from "../http/envelope.js";
import { testMcpServer, McpTestError } from "../integrations/mcpTest.js";
import type { FixedWindowLimiter } from "../auth/limiter.js";

const McpTestBody = z.object({ url: z.string().min(10).max(2048) });

/**
 * 集成连接测试。地址只用于本次请求，不保存；返回结果中不包含地址。
 */
export function integrationRoutes(deps: { limiter: FixedWindowLimiter }) {
  const r = new Hono<{ Variables: AppVariables }>();

  r.post("/mcp-test", async (c) => {
    if (!deps.limiter.hit(`mcp-test:${c.get("user").id}`)) throw new AppError(429, "测试过于频繁，请稍后再试");
    const parsed = McpTestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "请填写 MCP 服务地址");
    try {
      const result = await testMcpServer(parsed.data.url);
      return ok(c, result);
    } catch (e) {
      if (e instanceof McpTestError) throw new AppError(e.status, e.message);
      console.error("mcp connection test failed:", (e as Error).name);
      throw new AppError(502, "连接测试失败，请稍后再试");
    }
  });

  return r;
}
