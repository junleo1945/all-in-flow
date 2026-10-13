import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRuntime } from "../src/agent/models.js";
import { createSessionRegistry } from "../src/agent/registry.js";
import { createDb, type Db } from "../src/db/client.js";
import { conversations, sessionEntries, users, workflows, workflowVersions, usageDaily } from "../src/db/schema/index.js";
import { createConversation } from "../src/db/repos/conversationRepo.js";
import { salesReport } from "./fixtures.js";
import type { WorkflowIR } from "@aif/workflow-ir";

const url = process.env.DATABASE_URL;
const USER_ID = 990002;

describe.skipIf(!url)("访谈 Agent（假模型 + 真实数据库）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let convId: string;
  let faux: ReturnType<typeof fauxProvider>;
  let runtime: Awaited<ReturnType<typeof createRuntime>>;
  const generated: WorkflowIR[] = [];

  beforeAll(async () => {
    const c = createDb(url);
    db = c.db;
    close = () => c.sql.end();
    await db.insert(users).values({ id: USER_ID, username: "agent-test", displayName: "测试" }).onConflictDoNothing();
    convId = (await createConversation(db, USER_ID)).id;

    faux = fauxProvider();
    runtime = await createRuntime({});
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, "test-key");
  });

  afterAll(async () => {
    if (!db) return;
    const wfs = await db.select({ id: workflows.id }).from(workflows).where(eq(workflows.userId, USER_ID));
    for (const w of wfs) await db.delete(workflowVersions).where(eq(workflowVersions.workflowId, w.id));
    await db.delete(workflows).where(eq(workflows.userId, USER_ID));
    await db.delete(sessionEntries).where(eq(sessionEntries.conversationId, convId));
    await db.delete(conversations).where(eq(conversations.userId, USER_ID));
    await db.delete(usageDaily).where(eq(usageDaily.userId, USER_ID));
    await db.delete(users).where(eq(users.id, USER_ID));
    await close();
  });

  const makeRegistry = () =>
    createSessionRegistry({
      db,
      runtime,
      agentModel: faux.getModel(),
      generateIr: async (brief) => {
        generated.push(salesReport);
        return { ir: { ...salesReport, description: brief.slice(0, 40) || salesReport.description }, warnings: [] };
      },
    });

  it("工具调用写入画像，并把事件推送给调用方", async () => {
    const registry = makeRegistry();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("update_profile", { role: "销售运营", team: "华南销售部" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("record_task", { title: "销售周报", frequency: "weekly", minutesPerRun: 210 })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好的，我记下了你的周报工作。下一步想聊聊哪一步最费时间？"),
    ]);

    const events: Array<[string, unknown]> = [];
    await registry.prompt(USER_ID, convId, "我是销售运营，每周要做销售周报", (e, d) => events.push([e, d]));

    const names = events.filter(([e]) => e === "tool").map(([, d]) => (d as any).name);
    expect(names).toContain("update_profile");
    expect(names).toContain("record_task");
    expect(events.some(([e]) => e === "text_delta")).toBe(true);
    expect(events.some(([e, d]) => e === "state_patch" && (d as any).task?.title === "销售周报")).toBe(true);

    const [conv] = await db.select().from(conversations).where(eq(conversations.id, convId));
    const profile = conv!.profile as any;
    expect(profile.role.role).toBe("销售运营");
    expect(profile.tasks[0].title).toBe("销售周报");
    registry.dispose(convId);
  }, 30000);

  it("会话条目持久化到数据库，header 在第一条", async () => {
    const rows = await db.select().from(sessionEntries).where(eq(sessionEntries.conversationId, convId)).orderBy(sessionEntries.seq);
    expect(rows.length).toBeGreaterThan(3);
    expect((rows[0]!.entry as any).type).toBe("session");
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i));
  });

  it("进程重启后从数据库恢复会话，保留上下文", async () => {
    const before = await db.select().from(sessionEntries).where(eq(sessionEntries.conversationId, convId));
    const registry = makeRegistry(); // 全新注册表，内存中没有任何会话
    faux.setResponses([fauxAssistantMessage("我们上次聊到了销售周报，耗时约 3.5 小时。")]);
    await registry.prompt(USER_ID, convId, "我们上次聊到哪了？", () => {});

    const after = await db.select().from(sessionEntries).where(eq(sessionEntries.conversationId, convId));
    expect(after.length).toBeGreaterThan(before.length);
    const a = await registry.open(USER_ID, convId);
    const userTexts = a.session.messages
      .filter((m: any) => m.role === "user")
      .map((m: any) => (typeof m.content === "string" ? m.content : m.content?.[0]?.text));
    // 用户消息前面会带上 <aif-context> 状态块，所以按包含判断
    const has = (s: string) => userTexts.some((t) => t?.includes(s));
    expect(has("我是销售运营，每周要做销售周报")).toBe(true);
    expect(has("我们上次聊到哪了？")).toBe(true);
    expect(has("<aif-context>")).toBe(true);
    registry.dispose(convId);
  }, 30000);

  it("emit_workflow 新建工作流，再次调用并传入 basedOnWorkflowId 则新增版本", async () => {
    const registry = makeRegistry();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("emit_workflow", { brief: "周报自动汇总" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("已生成工作流 v1。"),
    ]);
    const events: Array<[string, any]> = [];
    await registry.prompt(USER_ID, convId, "就用第一个方案", (e, d) => events.push([e, d]));
    const wfEvent = events.find(([e]) => e === "workflow")![1];
    expect(wfEvent.version).toBe(1);

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("emit_workflow", { brief: "加上邮件通知", basedOnWorkflowId: wfEvent.workflowId })], { stopReason: "toolUse" }),
      fauxAssistantMessage("已新增 v2。"),
    ]);
    const events2: Array<[string, any]> = [];
    await registry.prompt(USER_ID, convId, "加一个邮件通知", (e, d) => events2.push([e, d]));
    expect(events2.find(([e]) => e === "workflow")![1].version).toBe(2);

    const versions = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, wfEvent.workflowId));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    registry.dispose(convId);
  }, 30000);

  it("同一会话并发消息返回 busy", async () => {
    const registry = makeRegistry();
    faux.setResponses([fauxAssistantMessage("第一条")]);
    const first = registry.prompt(USER_ID, convId, "第一条", () => {});
    await expect(registry.prompt(USER_ID, convId, "第二条", () => {})).rejects.toThrow("处理中");
    await first;
    registry.dispose(convId);
  }, 30000);

  it("记录用量到 usage_daily", async () => {
    const [row] = await db.select().from(usageDaily).where(eq(usageDaily.userId, USER_ID));
    expect(row).toBeDefined();
    expect(Number(row!.inputTokens)).toBeGreaterThan(0);
  });
});
