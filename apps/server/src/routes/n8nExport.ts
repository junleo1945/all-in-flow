import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { migrateIr } from "@aif/workflow-ir";
import type { AppVariables } from "../http/context.js";
import { AppError } from "../http/envelope.js";
import type { Db } from "../db/client.js";
import type { FixedWindowLimiter } from "../auth/limiter.js";
import type { AppConfig } from "../config.js";
import { assertBudget, QuotaExceeded, recordUsage } from "../agent/quota.js";
import { getVersion, getWorkflowForUser, NotFoundError } from "../db/repos/workflowRepo.js";
import { McpError, McpSession, type McpDeps } from "../n8n/mcp.js";
import { createToolbox } from "../n8n/toolbox.js";
import { ExportAborted, type N8nExporter } from "../n8n/exportAgent.js";
import { loadAuthorization } from "./authorizations.js";

const Body = z.object({ authorizationId: z.string().uuid(), version: z.number().int().positive().optional() });

/**
 * 把流程图导出为 n8n 工作流（n8n-export-skill.md）：SSE，事件 progress / result / error。
 * 需要用户先在授权管理里添加 n8n；每个用户同一时间只能跑一个，并按分钟限流。
 */
export function n8nExportRoutes(deps: {
  db: Db;
  config: Pick<AppConfig, "dailyTokenQuotaPerUser" | "dailyCostLimitUsd" | "authSecretKey"> & { allowPrivateHosts?: boolean };
  exporter?: N8nExporter;
  limiter: FixedWindowLimiter;
  mcp?: McpDeps;
}) {
  const r = new Hono<{ Variables: AppVariables }>();
  const running = new Set<number>();

  r.post("/:id/n8n-export", async (c) => {
    if (!deps.exporter || !deps.config.authSecretKey) throw new AppError(503, "n8n 导出未启用");
    const userId = c.get("user").id;
    const parsed = Body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "请先选择一个 n8n 授权");
    let wf;
    try {
      wf = await getWorkflowForUser(deps.db, userId, c.req.param("id"));
    } catch (e) {
      if (e instanceof NotFoundError) throw new AppError(404, e.message);
      throw e;
    }
    const version = parsed.data.version ?? wf.latestVersion;
    if (version > wf.latestVersion) throw new AppError(400, "版本号无效");
    const row = await getVersion(deps.db, wf.id, version).catch((e) => {
      if (e instanceof NotFoundError) throw new AppError(404, e.message);
      throw e;
    });
    const auth = await loadAuthorization(deps.db, deps.config.authSecretKey, userId, parsed.data.authorizationId);
    if (!deps.limiter.hit(`n8n-export:${userId}`)) throw new AppError(429, "导出太频繁，请稍后再试");
    if (running.has(userId)) throw new AppError(409, "已有一个导出正在进行");
    try {
      await assertBudget(deps.db, userId, deps.config as AppConfig);
    } catch (e) {
      if (e instanceof QuotaExceeded) throw new AppError(429, e.message);
      throw e;
    }

    const ir = migrateIr(row.ir);
    running.add(userId);
    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
      let session: McpSession | undefined;
      // 使用者关掉弹窗（连接断开）时取消导出，不再继续消耗模型额度
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      try {
        session = await McpSession.open(auth.url, auth.token, { ...deps.mcp, allowPrivateHosts: deps.config.allowPrivateHosts });
        // 导出要用 n8n 的节点和凭证查询：不是 n8n 的 MCP 就说明白
        const tools = await session.availableTools();
        if (!tools.includes("search_nodes") || !tools.includes("get_node_types")) {
          throw new McpError("这个 MCP 不是 n8n 的，或没有开放查询节点的工具；请在 n8n 的 MCP 设置里开启后重试", 400);
        }
        const result = await deps.exporter!({
          ir,
          toolbox: createToolbox(session),
          signal: controller.signal,
          onProgress: (stage) => void send("progress", { stage }),
          onUsage: (usage) => recordUsage(deps.db, userId, usage),
        });
        await send("result", { version, ...result });
      } catch (e) {
        if (e instanceof ExportAborted) return; // 已经取消，没有人在等结果
        // 只给用户可读的原因；其余错误只记类型，不记内容（可能含 token 或流程内容）
        if (!(e instanceof McpError)) console.error("n8n export failed:", (e as Error).name);
        await send("error", { message: e instanceof McpError ? e.message : "导出失败，请稍后重试" });
      } finally {
        await session?.close();
        running.delete(userId);
      }
    });
  });

  return r;
}
