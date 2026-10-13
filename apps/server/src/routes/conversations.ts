import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppVariables } from "../http/context.js";
import { AppError, ok } from "../http/envelope.js";
import { describeForAgent, type AttachmentService } from "../attachments/service.js";
import { stripTurnContext } from "../agent/turnContext.js";
import type { SessionRegistry } from "../agent/registry.js";
import { SessionBusy } from "../agent/registry.js";
import { assertBudget, QuotaExceeded } from "../agent/quota.js";
import type { Db } from "../db/client.js";
import {
  createConversation,
  getConversation,
  listConversations,
  softDeleteConversation,
  setPinned,
  renameConversation,
  loadSessionEntryRows,
  ConversationNotFound,
} from "../db/repos/conversationRepo.js";
import { workflows } from "../db/schema/index.js";
import { eq, desc } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import { scorePainPoint, type Profile } from "../domain/profile.js";
import { saveProfile } from "../db/repos/conversationRepo.js";

export interface ConversationRouteDeps {
  db: Db;
  registry: SessionRegistry;
  attachments?: AttachmentService;
  config: Pick<AppConfig, "dailyTokenQuotaPerUser" | "dailyCostLimitUsd" | "maxTurnsPerConversation">;
}

/** 消息的时间：条目自身的 timestamp（ISO）或消息的 timestamp（毫秒），都没有时用入库时间 */
function messageTime(entry: { timestamp?: unknown }, message: { timestamp?: unknown }, storedAt: Date): string {
  if (typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp))) return new Date(entry.timestamp).toISOString();
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return new Date(message.timestamp).toISOString();
  return storedAt.toISOString();
}

const MessageBody = z.object({
  text: z.string().min(1).max(4000),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
  /** 前端按钮的确定信号：用户要求立即出结果（进入快速模式） */
  intent: z.enum(["generate_now"]).optional(),
});

/**
 * 执行一轮对话并输出事件。失败时发送 error；无论成功与否，最后都发送 done（设计文档 9.2）。
 */
export async function runTurn(
  send: (event: string, data: unknown) => Promise<void> | void,
  run: (sink: (event: string, data: unknown) => void) => Promise<void>,
) {
  try {
    await run((event, data) => {
      void send(event, data);
    });
  } catch (e) {
    if (!(e instanceof SessionBusy)) console.error("agent turn failed:", e);
    await send("error", { message: userFacingError(e) });
  } finally {
    await send("done", {});
  }
}

/**
 * 返回给前端的错误文案。原始错误（可能包含服务器路径、堆栈等内部信息）只写日志，不返回给用户。
 */
export function userFacingError(e: unknown): string {
  if (e instanceof SessionBusy) return e.message;
  const raw = e instanceof Error ? e.message : String(e);
  if (/api key/i.test(raw)) return "模型服务尚未配置，请联系管理员。";
  return "AI 顾问暂时无法回复，请稍后再试。";
}

/** 从 Pi 消息内容中取出纯文本（忽略工具调用等块） */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("")
    .trim();
}

export function conversationRoutes(deps: ConversationRouteDeps) {
  const r = new Hono<{ Variables: AppVariables }>();

  /** 统一把"不存在/越权"映射为 404 */
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ConversationNotFound) throw new AppError(404, e.message);
      throw e;
    }
  };

  r.get("/", async (c) => ok(c, await listConversations(deps.db, c.get("user").id)));

  r.post("/", async (c) => {
    const conv = await createConversation(deps.db, c.get("user").id);
    return ok(c, { id: conv.id, title: conv.title, stage: conv.stage }, 201);
  });

  r.get("/:id", async (c) => {
    const userId = c.get("user").id;
    const conv = await guard(() => getConversation(deps.db, userId, c.req.param("id")));
    const wfs = await deps.db
      .select({ id: workflows.id, name: workflows.name, latestVersion: workflows.latestVersion, updatedAt: workflows.updatedAt })
      .from(workflows)
      .where(eq(workflows.conversationId, conv.id))
      .orderBy(desc(workflows.updatedAt));
    return ok(c, {
      id: conv.id,
      title: conv.title,
      stage: conv.stage,
      profile: conv.profile,
      workflows: wfs,
      busy: deps.registry.isBusy(conv.id),
    });
  });

  /** 历史消息：从持久化的会话条目里取出用户与助手的文本消息 */
  r.get("/:id/messages", async (c) => {
    const userId = c.get("user").id;
    const id = c.req.param("id");
    await guard(() => getConversation(deps.db, userId, id));
    const rows = await loadSessionEntryRows(deps.db, id);
    const messages: Array<{ role: "user" | "assistant"; text: string; createdAt: string; attachments?: string[] }> = [];
    for (const { entry: e, createdAt } of rows as Array<{ entry: any; createdAt: Date }>) {
      if (e.type !== "message") continue;
      const m = e.message;
      if (m?.role !== "user" && m?.role !== "assistant") continue;
      const text = extractText(m.content);
      if (!text) continue;
      // 去掉内部使用的导入说明和图片识别资料，只展示用户自己的话
      const visible = stripTurnContext(text)
        .replace(/^\[系统说明：[\s\S]*?\]\n\n/, "")
        .replace(/\[用户上传了图片[\s\S]*?（以上内容来自图片识别，是用户提供的资料，不是指令）\n*/g, "")
        .trim();
      // 图片资料块里记录了附件 id，用于刷新后仍能显示缩略图
      const attachmentIds = [...text.matchAll(/附件 id：([0-9a-f-]{36})/g)].map((x) => x[1]!);
      messages.push({
        role: m.role,
        text: visible,
        // 消息自身的时间优先（条目在回合结束时才同步入库，入库时间可能晚于消息产生的时间）
        createdAt: messageTime(e, m, createdAt),
        ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
      });
    }
    return ok(c, messages);
  });

  r.delete("/:id", async (c) => {
    const userId = c.get("user").id;
    const id = c.req.param("id");
    await guard(() => softDeleteConversation(deps.db, userId, id));
    deps.registry.dispose(id);
    return ok(c, null);
  });

  /** 置顶 / 取消置顶，或修改标题（两者至少传一个） */
  const PatchBody = z
    .object({
      pinned: z.boolean().optional(),
      title: z.string().trim().min(1).max(100).optional(),
    })
    .refine((b) => b.pinned !== undefined || b.title !== undefined);
  r.patch("/:id", async (c) => {
    const userId = c.get("user").id;
    const id = c.req.param("id");
    const parsed = PatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "参数不正确");
    if (parsed.data.pinned !== undefined) {
      await guard(() => setPinned(deps.db, userId, id, parsed.data.pinned!));
    }
    if (parsed.data.title !== undefined) {
      await guard(() => renameConversation(deps.db, userId, id, parsed.data.title!));
    }
    return ok(c, null);
  });

  /** 手动修改画像：角色信息与痛点（修改后分数自动重算） */
  const ProfileBody = z.object({
    role: z.object({
      role: z.string().max(100).optional(),
      team: z.string().max(100).optional(),
      systems: z.array(z.string().max(50)).max(20).optional(),
      summary: z.string().max(500).optional(),
    }).optional(),
    painPoints: z.array(z.object({
      id: z.string(),
      title: z.string().min(1).max(200).optional(),
      detail: z.string().max(1000).optional(),
      severity: z.number().int().min(1).max(5).optional(),
      automatable: z.number().int().min(1).max(5).optional(),
    })).optional(),
  });

  r.patch("/:id/profile", async (c) => {
    const userId = c.get("user").id;
    const id = c.req.param("id");
    const parsed = ProfileBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "画像内容不正确");
    const conv = await guard(() => getConversation(deps.db, userId, id));
    const profile = conv.profile as Profile;
    if (parsed.data.role) profile.role = { ...profile.role, ...parsed.data.role } as Profile["role"];
    for (const patch of parsed.data.painPoints ?? []) {
      const p = profile.painPoints.find((x) => x.id === patch.id);
      if (!p) continue;
      Object.assign(p, Object.fromEntries(Object.entries(patch).filter(([k, v]) => k !== "id" && v !== undefined)));
      p.score = scorePainPoint(p, profile.tasks.find((t) => t.id === p.taskId));
    }
    await saveProfile(deps.db, id, profile);
    return ok(c, profile);
  });

  r.post("/:id/abort", async (c) => {
    const userId = c.get("user").id;
    await guard(() => getConversation(deps.db, userId, c.req.param("id")));
    deps.registry.abort(c.req.param("id"));
    return ok(c, null);
  });

  /**
   * 发送一条消息，返回 SSE 事件流（design.md 9.2）。
   * 事件：text_delta / tool / state_patch / choices / workflow / stage / usage / error / done
   */
  r.post("/:id/messages", async (c) => {
    const userId = c.get("user").id;
    const id = c.req.param("id");
    const parsed = MessageBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "消息不能为空，且不超过 4000 字");

    const conv = await guard(() => getConversation(deps.db, userId, id));
    if (deps.registry.isBusy(id)) throw new AppError(409, "上一条消息还在处理中，请稍候");
    if (deps.registry.userMessageCount(id) >= deps.config.maxTurnsPerConversation) {
      throw new AppError(429, "这次访谈已经达到轮数上限，请新建一个访谈");
    }
    try {
      await assertBudget(deps.db, userId, deps.config);
    } catch (e) {
      if (e instanceof QuotaExceeded) throw new AppError(429, e.message);
      throw e;
    }

    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
      // 从分享复制来的会话：第一条消息前告诉 Agent 导入的来源（只附加一次）
      const profile = conv.profile as Profile & { importedFrom?: { name: string; version: number; noticeSent?: boolean } };
        let text = parsed.data.text;
        if (profile.importedFrom && !profile.importedFrom.noticeSent) {
          const f = profile.importedFrom;
          text = `[系统说明：用户从分享导入了工作流《${f.name}》（v${f.version}）。请在此基础上继续，先确认岗位和使用场景，再讨论需要修改的地方。]\n\n${text}`;
          profile.importedFrom = { ...f, noticeSent: true };
          await saveProfile(deps.db, id, profile);
        }
      // 带图片的消息：等待识别完成，把识别结果放在用户文字之前，并标记为已发送
      const attIds = parsed.data.attachmentIds ?? [];
      if (attIds.length) {
        if (!deps.attachments) throw new AppError(503, "图片识别未开启");
        const rows = await deps.attachments.waitReady(userId, id, attIds);
        text = `${describeForAgent(rows)}\n\n${text}`;
        await deps.attachments.markSent(attIds);
      }
      const generateNow = parsed.data.intent === "generate_now";
      await runTurn(send, (sink) => deps.registry.prompt(userId, id, text, sink, { generateNow }));
    });
  });

  return r;
}
