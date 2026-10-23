import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRuntime } from "../src/agent/models.js";
import { createDb, type Db } from "../src/db/client.js";
import { users, conversations, sessionEntries, usageDaily, workflows, workflowVersions } from "../src/db/schema/index.js";
import { eq } from "drizzle-orm";
import { PERSONAS } from "@aif/evals";
import { runPersona, userSimPrompt, USER_SIM_MARKER } from "../src/eval/runner.js";
import { salesReport } from "./fixtures.js";

const url = process.env.DATABASE_URL;
const EVAL_USER = 990950;

describe.skipIf(!url)("评测运行器（假模型：Agent 与模拟用户共用一个假模型）", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const c = createDb(url);
    db = c.db;
    close = () => c.sql.end();
    await db.insert(users).values({ id: EVAL_USER, username: "eval-test", displayName: "评测测试" }).onConflictDoNothing();
  });

  afterAll(async () => {
    if (!db) return;
    // 按依赖顺序清理：版本 → 工作流 → 会话条目 → 会话
    const wfs = await db.select({ id: workflows.id }).from(workflows).where(eq(workflows.userId, EVAL_USER));
    for (const w of wfs) await db.delete(workflowVersions).where(eq(workflowVersions.workflowId, w.id));
    await db.delete(workflows).where(eq(workflows.userId, EVAL_USER));
    const convs = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.userId, EVAL_USER));
    for (const c of convs) await db.delete(sessionEntries).where(eq(sessionEntries.conversationId, c.id));
    await db.delete(conversations).where(eq(conversations.userId, EVAL_USER));
    await db.delete(usageDaily).where(eq(usageDaily.userId, EVAL_USER));
    await db.delete(users).where(eq(users.id, EVAL_USER));
    await close();
  });

  it("完整跑通一次模拟访谈：对话、画像读取、打分都有结果", async () => {
    const faux = fauxProvider();
    const runtime = await createRuntime({});
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, "k");

    // 假模型按系统提示词区分角色：模拟用户回复一句话；访谈 Agent 按轮次记录工作与痛点，然后生成工作流
    let agentTurn = 0;
    // 假模型的队列每次调用消耗一项，工厂需要被多次复用
    const factory = (context: any) => {
        // pi-ai 会把 systemPrompt 折叠进 messages 中的 system 消息，所以在消息内容里查找标记
        if (JSON.stringify(context.messages).includes(USER_SIM_MARKER)) {
          return fauxAssistantMessage("我每周都要手工导出订单做透视，很花时间。");
        }
        agentTurn += 1;
        if (agentTurn === 1) return fauxAssistantMessage([fauxToolCall("record_task", { title: "销售周报", frequency: "weekly", minutesPerRun: 210 })], { stopReason: "toolUse" });
        if (agentTurn === 2) return fauxAssistantMessage([fauxToolCall("record_pain_point", { title: "手工导出并透视订单", detail: "每周手工透视", severity: 4, automatable: 5 })], { stopReason: "toolUse" });
        if (agentTurn === 3) return fauxAssistantMessage([fauxToolCall("emit_workflow", { brief: "周报自动汇总" })], { stopReason: "toolUse" });
        return fauxAssistantMessage("已生成工作流。");
    };
    faux.setResponses(Array.from({ length: 80 }, () => factory as any));

    const persona = PERSONAS.find((p) => p.id === "sales-ops")!;
    const result = await runPersona(
      {
        db,
        runtime,
        agentModel: faux.getModel(),
        userModel: faux.getModel(),
        generateIr: async () => ({ ir: salesReport, warnings: [] }),
        maxTurns: 6,
        evalUserId: EVAL_USER,
      },
      persona,
    );

    expect(result.transcript[0]!.role).toBe("user");
    expect(result.run.taskCount).toBe(1);
    expect(result.run.firstWorkflowTurn).toBeDefined();
    expect(result.run.workflowValidity).toEqual([true]);
    // 只记录了一个痛点，它就是聚焦的痛点："手工导出并透视订单"命中人设中的 sa1（关键词：透视、导出、手工）
    expect(result.metrics.focusedId).toBe("sa1");
    expect(result.metrics.extraTasks).toBe(0);
  }, 20000);
});

describe("模拟用户的提示词", () => {
  it("「说不清耗时」的人设会被要求：给档位就选，要分钟数就说不好说，被追问会不耐烦", () => {
    const vague = PERSONAS.find((p) => p.cannotEstimate)!;
    const prompt = userSimPrompt(vague);
    expect(prompt).toContain(USER_SIM_MARKER);
    expect(prompt).toContain("不好说，没算过");
    expect(prompt).toContain("别问时间了");
  });

  it("普通人设的提示词里没有这条规则", () => {
    const normal = PERSONAS.find((p) => !p.cannotEstimate)!;
    expect(userSimPrompt(normal)).not.toContain("不好说，没算过");
  });
});
