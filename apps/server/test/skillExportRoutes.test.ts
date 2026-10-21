import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { WorkflowIR } from "@aif/workflow-ir";
import { createDb, type Db } from "../src/db/client.js";
import { conversations, usageDaily, users, workflows, workflowVersions } from "../src/db/schema/index.js";
import { skillExportRoutes } from "../src/routes/skillExport.js";
import { FixedWindowLimiter } from "../src/auth/limiter.js";
import { AppError, fail } from "../src/http/envelope.js";
import type { AppVariables } from "../src/http/context.js";
import type { SkillAuthor, SkillAuthorInput, SkillAuthorResult } from "../src/skill/authorAgent.js";

const url = process.env.DATABASE_URL;
const OWNER = 990061;
const OTHER = 990062;
const LEAK = "secret-must-not-leak";

const ir = (kind: "automation" | "process" = "automation"): WorkflowIR => ({
  version: 2,
  kind,
  slug: "weekly",
  name: "周报",
  description: "汇总周报。当用户需要写周报时使用。",
  trigger: { type: "manual", detail: "手动" },
  inputs: [],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    { id: "n1", type: "step", title: "生成周报", executor: "llm", instructions: "按模板汇总本周数据", action: { kind: "llm", prompt: "生成周报" } },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "e" },
  ],
  source: { painPointIds: ["p1"] },
});

const okResult: SkillAuthorResult = {
  files: [{ path: "weekly/SKILL.md", content: "---\nname: weekly\n---\n" }],
  filename: "weekly.skill.zip",
  issues: [],
  warnings: [],
  todo: ["确认模板"],
  fallback: false,
};

describe.skipIf(!url)("用模型撰写 Skill 的路由（真实数据库 + 假 agent）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let wfId: string;
  let processWfId: string;
  let convId: string;

  beforeAll(async () => {
    const c = createDb(url);
    db = c.db;
    close = () => c.sql.end();
    await db.insert(users).values([{ id: OWNER, username: "skill-export", displayName: "导出测试" }, { id: OTHER, username: "skill-export-2", displayName: "另一个人" }]).onConflictDoNothing();
    const profile = {
      role: { role: "销售运营", systems: ["ERP"] },
      tasks: [],
      painPoints: [{ id: "p1", title: "周报太耗时", detail: "每周五写一个半小时", severity: 4, automatable: 4, evidence: "我每周五下午都在写周报", score: 1 }],
      candidates: [],
      notes: [],
      fastTrack: false,
    };
    const [conv] = await db.insert(conversations).values({ userId: OWNER, profile }).returning();
    convId = conv!.id;
    const [wf] = await db.insert(workflows).values({ conversationId: convId, userId: OWNER, name: "周报", latestVersion: 1 }).returning();
    wfId = wf!.id;
    await db.insert(workflowVersions).values({ workflowId: wfId, version: 1, ir: ir() });
    const [pwf] = await db.insert(workflows).values({ conversationId: convId, userId: OWNER, name: "流程", latestVersion: 1 }).returning();
    processWfId = pwf!.id;
    await db.insert(workflowVersions).values({ workflowId: processWfId, version: 1, ir: ir("process") });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(usageDaily).where(inArray(usageDaily.userId, [OWNER, OTHER]));
    await db.delete(workflowVersions).where(inArray(workflowVersions.workflowId, [wfId, processWfId]));
    await db.delete(workflows).where(inArray(workflows.id, [wfId, processWfId]));
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(users).where(inArray(users.id, [OWNER, OTHER]));
    await close();
  });

  function buildApp(userId: number, over: { author?: SkillAuthor | null; limit?: number; quota?: number } = {}) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("locale", "zh");
      c.set("user", { id: userId } as AppVariables["user"]);
      await next();
    });
    app.route(
      "/api/workflows",
      skillExportRoutes({
        db: db!,
        config: { dailyTokenQuotaPerUser: over.quota ?? 2_000_000, dailyCostLimitUsd: 1000 },
        author: over.author === null ? undefined : (over.author ?? (async () => okResult)),
        limiter: new FixedWindowLimiter(over.limit ?? 100, 60_000),
      }),
    );
    app.onError((err, c) => {
      if (err instanceof AppError) return fail(c, err.status, err.message, err.code);
      throw err;
    });
    return app;
  }
  const post = (app: Hono<any>, id: string, body: unknown) =>
    app.request(`/api/workflows/${id}/skill-export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const events = async (res: Response) =>
    (await res.text())
      .split("\n\n")
      .filter(Boolean)
      .map((block) => ({ event: /^event: (.*)$/m.exec(block)?.[1], data: /^data: (.*)$/m.exec(block)?.[1] ? JSON.parse(/^data: (.*)$/m.exec(block)![1]!) : undefined }));

  it("把工作流、选项、缺口和画像摘录交给 agent；推送进度和结果；用量记入配额", async () => {
    let seen: SkillAuthorInput | undefined;
    const author: SkillAuthor = async (input) => {
      seen = input;
      input.onProgress?.("analyze");
      input.onProgress?.("write");
      input.onProgress?.("validate");
      await input.onUsage?.({ input: 1000, output: 500, cacheRead: 0, costUsd: 0.01 });
      return okResult;
    };
    const res = await post(buildApp(OWNER, { author }), wfId, { target: "claude-code", packaging: "claude-plugin" });
    expect(res.status).toBe(200);
    const evs = await events(res);
    expect(evs.map((e) => e.event)).toEqual(["progress", "progress", "progress", "result"]);
    expect(evs.map((e) => e.data?.stage).filter(Boolean)).toEqual(["analyze", "write", "validate"]);
    expect(evs.at(-1)!.data).toMatchObject({ version: 1, filename: "weekly.skill.zip", fallback: false, todo: ["确认模板"], files: [{ path: "weekly/SKILL.md" }] });

    expect(seen!.options).toEqual({ target: "claude-code", packaging: "claude-plugin" });
    expect(seen!.ir.slug).toBe("weekly");
    expect(seen!.gaps).toEqual(["「生成周报」用什么模板或输出格式？"]);
    expect(seen!.context).toContain("我每周五下午都在写周报");
    const [usage] = await db.select().from(usageDaily).where(eq(usageDaily.userId, OWNER));
    expect(usage!.inputTokens).toBe(1000);
  });

  it("导出前补充的内容随请求带来：套用到工作流后再生成，缺口随之消失", async () => {
    let seen: SkillAuthorInput | undefined;
    const author: SkillAuthor = async (input) => ((seen = input), okResult);
    await (await post(buildApp(OWNER, { author }), wfId, { answers: { n1: "三段：销售额、环比、Top 3" } })).text();
    const step = seen!.ir.nodes.find((n) => n.id === "n1") as { template?: string };
    expect(step.template).toBe("三段：销售额、环比、Top 3");
    expect(seen!.gaps).toEqual([]);
  });

  it("读不到访谈画像（会话被删除）时照常导出，只是没有背景", async () => {
    const [conv] = await db.insert(conversations).values({ userId: OWNER, deletedAt: new Date() }).returning();
    const [wf] = await db.insert(workflows).values({ conversationId: conv!.id, userId: OWNER, name: "无画像", latestVersion: 1 }).returning();
    await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, ir: ir() });
    try {
      let seen: SkillAuthorInput | undefined;
      const author: SkillAuthor = async (input) => ((seen = input), okResult);
      await (await post(buildApp(OWNER, { author }), wf!.id, {})).text();
      expect(seen!.context).toBe("");
    } finally {
      await db.delete(workflowVersions).where(eq(workflowVersions.workflowId, wf!.id));
      await db.delete(workflows).where(eq(workflows.id, wf!.id));
      await db.delete(conversations).where(eq(conversations.id, conv!.id));
    }
  });

  it("回退结果原样转给前端（fallback 与原因）", async () => {
    const author: SkillAuthor = async () => ({ ...okResult, fallback: true, fallbackReason: "模型暂时不可用，已使用基础版本" });
    const evs = await events(await post(buildApp(OWNER, { author }), wfId, {}));
    expect(evs.at(-1)!.data).toMatchObject({ fallback: true, fallbackReason: "模型暂时不可用，已使用基础版本" });
  });

  it("agent 出错：推送 error 事件，不泄漏内部信息", async () => {
    const author: SkillAuthor = async () => {
      throw new Error(`内部错误含 ${LEAK}`);
    };
    const evs = await events(await post(buildApp(OWNER, { author }), wfId, {}));
    expect(evs.at(-1)).toEqual({ event: "error", data: { message: "导出失败，请稍后重试" } });
    expect(JSON.stringify(evs)).not.toContain(LEAK);
  });

  it("参数与权限：别人的工作流 404、参数不对 400、版本无效 400、没有启用 503、不是 automation 400", async () => {
    const app = buildApp(OWNER);
    expect((await post(buildApp(OTHER), wfId, {})).status).toBe(404);
    expect((await post(app, wfId, { target: "windows" })).status).toBe(400);
    expect((await post(app, wfId, { answers: { n1: 123 } })).status).toBe(400);
    expect((await post(app, wfId, { version: 9 })).status).toBe(400);
    expect((await post(buildApp(OWNER, { author: null }), wfId, {})).status).toBe(503);
    const blocked = await post(app, processWfId, {});
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).message).toContain("automation");
  });

  it("按分钟限流；不能导出的请求不占用限流", async () => {
    const app = buildApp(OWNER, { limit: 1 });
    expect((await post(app, processWfId, {})).status).toBe(400);
    const first = await post(app, wfId, {});
    expect(first.status).toBe(200);
    await first.text();
    expect((await post(app, wfId, {})).status).toBe(429);
  });

  it("同一用户同时只能跑一个", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = buildApp(OWNER, { author: async () => (await gate, okResult) });
    const first = await post(app, wfId, {});
    expect(first.status).toBe(200);
    expect((await post(app, wfId, {})).status).toBe(409);
    release();
    await first.text();
    expect((await post(app, wfId, {})).status).toBe(200);
  });

  it("今日配额用完时拒绝", async () => {
    expect((await post(buildApp(OWNER, { quota: 0 }), wfId, {})).status).toBe(429);
  });
});
