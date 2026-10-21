import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { checkExport, lower, migrateIr } from "@aif/workflow-ir";
import { skillExporter, unconfirmedPaths } from "@aif/plugin-exporter-skill";
import { applyPromptAnswers, promptGaps } from "@aif/plugin-exporter-prompt";
import type { AppVariables } from "../http/context.js";
import { AppError } from "../http/envelope.js";
import type { Db } from "../db/client.js";
import type { FixedWindowLimiter } from "../auth/limiter.js";
import type { AppConfig } from "../config.js";
import { assertBudget, QuotaExceeded, recordUsage } from "../agent/quota.js";
import { getVersion, getWorkflowForUser, NotFoundError } from "../db/repos/workflowRepo.js";
import { getConversation } from "../db/repos/conversationRepo.js";
import { normalizeProfile } from "../domain/profile.js";
import { ExportAborted } from "../n8n/exportAgent.js";
import type { SkillAuthor } from "../skill/authorAgent.js";
import { buildContext } from "../skill/context.js";

const Body = z.object({
  version: z.number().int().positive().optional(),
  target: z.enum(["generic", "claude-code", "pi"]).default("generic"),
  packaging: z.enum(["zip", "claude-plugin"]).default("zip"),
  /** 导出前补充的判断标准、模板：节点 id → 内容。没有保存为新版本时随请求带来 */
  answers: z.record(z.string(), z.string().max(2000)).refine((a) => Object.keys(a).length <= 50, "回答太多").optional(),
});

/**
 * 用模型撰写 Agent Skill（skill-export-v3.md）：SSE，事件 progress / result / error。
 * 每个用户同一时间只能跑一个，按分钟限流，并计入模型配额；使用者断开连接即取消。
 * 模型不可用或写得不合格时服务端自己回退到确定性输出（result 里 fallback 为 true），导出不会因此失败。
 */
export function skillExportRoutes(deps: {
  db: Db;
  config: Pick<AppConfig, "dailyTokenQuotaPerUser" | "dailyCostLimitUsd">;
  author?: SkillAuthor;
  limiter: FixedWindowLimiter;
}) {
  const r = new Hono<{ Variables: AppVariables }>();
  const running = new Set<number>();

  r.post("/:id/skill-export", async (c) => {
    if (!deps.author) throw new AppError(503, "Skill 生成未启用");
    const userId = c.get("user").id;
    const parsed = Body.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AppError(400, "请求参数不正确");
    const { target, packaging, answers } = parsed.data;

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

    const ir = answers ? applyPromptAnswers(migrateIr(row.ir), answers) : migrateIr(row.ir);
    // 不能导出的（例如不是 automation）在开始前就拒绝，不占用限流和配额
    let blocked: string[];
    try {
      blocked = checkExport(skillExporter, lower(ir)).filter((i) => i.level === "error").map((i) => i.message);
    } catch {
      throw new AppError(400, "这张流程图无法导出为 Skill");
    }
    if (blocked.length) throw new AppError(400, blocked.join("；"));

    if (!deps.limiter.hit(`skill-export:${userId}`)) throw new AppError(429, "导出太频繁，请稍后再试");
    if (running.has(userId)) throw new AppError(409, "已有一个导出正在进行");
    try {
      await assertBudget(deps.db, userId, deps.config as AppConfig);
    } catch (e) {
      if (e instanceof QuotaExceeded) throw new AppError(429, e.message);
      throw e;
    }

    const gaps = [...promptGaps(ir).map((g) => g.question), ...unconfirmedPaths(ir)];
    // 访谈画像是辅助材料：会话被删除等情况下读不到，就不带
    const conversation = await getConversation(deps.db, userId, wf.conversationId).catch(() => undefined);
    const context = conversation ? buildContext(normalizeProfile(conversation.profile as never), ir) : "";

    running.add(userId);
    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
      // 使用者关掉弹窗（连接断开）时取消，不再继续消耗模型额度
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      try {
        const result = await deps.author!({
          ir,
          options: { target, packaging },
          gaps,
          context,
          signal: controller.signal,
          onProgress: (stage) => void send("progress", { stage }),
          onUsage: (usage) => recordUsage(deps.db, userId, usage),
        });
        await send("result", { version, ...result, files: result.files.map((f) => ({ path: f.path, content: String(f.content) })) });
      } catch (e) {
        if (e instanceof ExportAborted) return; // 已经取消，没有人在等结果
        // 只记错误类型，不记内容（可能含流程内容）
        console.error("skill export failed:", (e as Error).name);
        await send("error", { message: "导出失败，请稍后重试" });
      } finally {
        running.delete(userId);
      }
    });
  });

  return r;
}
