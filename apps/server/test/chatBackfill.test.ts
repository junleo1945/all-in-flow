import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "@aif/workflow-ir";
import { backfillChatInstructions, backfillItemFields, missingChatSteps, missingItemFields } from "../src/agent/chatBackfill.js";
import { salesReport } from "./fixtures.js";

describe("旧工作流补写 chatInstructions", () => {
  it("只给缺说明的 deterministic 步骤补写，其他内容不动", async () => {
    expect(missingChatSteps(salesReport).map((n) => n.id)).toEqual(["n1"]);
    const asked: string[] = [];
    const { ir, filled } = await backfillChatInstructions(salesReport, async (_s, p) => {
      asked.push(p);
      return '```json\n{"n1":"在 ERP 的订单查询里导出本周订单","n3":"不该被写入"}\n```';
    });
    expect(filled).toBe(1);
    const n1 = ir.nodes.find((n) => n.id === "n1");
    expect(n1?.type === "step" && n1.chatInstructions).toBe("在 ERP 的订单查询里导出本周订单");
    // 人工和大模型步骤保持原样
    expect(JSON.stringify(ir.nodes.filter((n) => n.id !== "n1"))).toBe(JSON.stringify(salesReport.nodes.filter((n) => n.id !== "n1")));
    expect(asked[0]).toContain("拉取本周订单");
    expect(asked[0]).not.toContain("生成周报");
  });

  it("没有缺口时不请求模型；模型输出无法解析或带引用时不写入", async () => {
    const done = (await backfillChatInstructions(salesReport, async () => '{"n1":"在 ERP 里导出"}')).ir;
    const none = await backfillChatInstructions(done, async () => {
      throw new Error("不应该被调用");
    });
    expect(none.filled).toBe(0);
    expect((await backfillChatInstructions(salesReport, async () => "不是 JSON")).filled).toBe(0);
    expect((await backfillChatInstructions(salesReport, async () => '{"n1":"导出 {{n1.orders}}"}')).filled).toBe(0);
  });
});

describe("旧工作流补写循环项字段说明", () => {
  // 对输入 resumes 逐项处理，子流程里用到 resume.name 和 resume.text
  const looped = (fields?: { name: string; description: string }[]): WorkflowIR => ({
    version: 2,
    kind: "automation",
    slug: "screen",
    name: "简历初筛",
    description: "逐份评估简历",
    trigger: { type: "manual", detail: "用户发起" },
    inputs: [{ name: "resumes", type: "array", items: "object", description: "候选人简历列表，每项包含 name 和 text", required: true, ...(fields ? { fields } : {}) }],
    nodes: [
      { id: "s", type: "start", title: "开始" },
      {
        id: "n1",
        type: "foreach",
        title: "逐份评估",
        over: "input.resumes",
        item: "resume",
        body: {
          nodes: [
            { id: "bs", type: "start", title: "开始" },
            { id: "b1", type: "step", title: "评估", executor: "llm", instructions: "评估 {{resume.name}}", action: { kind: "llm", prompt: "候选人：{{resume.name}}\n简历：{{resume.text}}" } },
            { id: "be", type: "end", title: "结束" },
          ],
          edges: [
            { from: "bs", to: "b1" },
            { from: "b1", to: "be" },
          ],
        },
      },
      { id: "e", type: "end", title: "结束" },
    ],
    edges: [
      { from: "s", to: "n1" },
      { from: "n1", to: "e" },
    ],
    source: { painPointIds: [] },
  });

  it("找出子流程里用到、但没有说明的字段", () => {
    expect(missingItemFields(looped())).toEqual([{ ref: "input.resumes", description: "候选人简历列表，每项包含 name 和 text", fields: ["name", "text"] }]);
    expect(missingItemFields(looped([{ name: "name", description: "候选人姓名" }]))[0]?.fields).toEqual(["text"]);
    expect(missingItemFields(looped([{ name: "name", description: "候选人姓名" }, { name: "text", description: "简历内容" }]))).toEqual([]);
  });

  it("补写后字段带上说明，已有说明的字段不动，其余内容不变", async () => {
    const src = looped([{ name: "name", description: "候选人姓名" }]);
    const { ir, filled } = await backfillItemFields(src, async () => '{"input.resumes":{"name":"不该覆盖","text":"简历内容"}}');
    expect(filled).toBe(1);
    expect(ir.inputs[0]?.fields).toEqual([
      { name: "name", description: "候选人姓名" },
      { name: "text", description: "简历内容" },
    ]);
    expect(JSON.stringify(ir.nodes)).toBe(JSON.stringify(src.nodes));
  });

  it("没有缺口时不请求模型；输出无法解析、带引用或过长时不写入", async () => {
    const done = looped([{ name: "name", description: "候选人姓名" }, { name: "text", description: "简历内容" }]);
    expect((await backfillItemFields(done, async () => { throw new Error("不应该被调用"); })).filled).toBe(0);
    expect((await backfillItemFields(looped(), async () => "不是 JSON")).filled).toBe(0);
    expect((await backfillItemFields(looped(), async () => '{"input.resumes":{"name":"{{x}}","text":"这是一段明显超过二十个字的说明文字不应该被当作字段名称写入"}}')).filled).toBe(0);
  });
});
