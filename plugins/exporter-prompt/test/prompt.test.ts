import { describe, expect, it } from "vitest";
import { FEATURE_LABELS, checkExport, lower, type WorkflowIR } from "@aif/workflow-ir";
import { v2Sample } from "../../../packages/workflow-ir/test/fixtures-v2.js";
import { applyPromptAnswers, promptExporter, promptGaps, renderPrompt } from "../src/index.js";

const base = (over: Partial<WorkflowIR> = {}): WorkflowIR => ({
  version: 2,
  kind: "automation",
  slug: "demo-flow",
  name: "演示流程",
  description: "整理客户反馈并生成回复草稿。当用户需要处理客户反馈时使用。",
  trigger: { type: "manual", detail: "用户发起" },
  inputs: [],
  nodes: [],
  edges: [],
  source: { painPointIds: [] },
  ...over,
});

/** 顶层：拉取订单（HTTP）→ 逐条处理（循环，内含判断）→ 生成草稿（大模型）→ 结束 */
const nested = (): WorkflowIR =>
  base({
    nodes: [
      { id: "s", type: "start", title: "开始" },
      {
        id: "n1",
        type: "step",
        title: "拉取订单",
        executor: "deterministic",
        instructions: "调用 ERP 查询订单",
        action: { kind: "http", method: "GET", url: "https://erp.example.com/api/orders" },
        outputs: [{ name: "items", type: "array", description: "订单列表" }],
      },
      {
        id: "n2",
        type: "foreach",
        title: "逐条处理反馈",
        over: "n1.items",
        item: "item",
        body: {
          nodes: [
            { id: "bs", type: "start", title: "开始" },
            { id: "b1", type: "step", title: "判断是否需要跟进", executor: "llm", instructions: "看订单状态", action: { kind: "llm", prompt: "判断" }, outputs: [{ name: "needFollowUp", type: "boolean", description: "是否需要跟进" }] },
            { id: "b2", type: "decision", title: "需要跟进？", mode: "expr" },
            { id: "b3", type: "step", title: "起草回复", executor: "llm", instructions: "写一段回复", action: { kind: "llm", prompt: "写回复" } },
            { id: "be", type: "end", title: "结束" },
          ],
          edges: [
            { from: "bs", to: "b1" },
            { from: "b1", to: "b2" },
            { from: "b2", to: "b3", label: "是", condition: { left: "b1.needFollowUp", op: "is_true" } },
            { from: "b2", to: "be", label: "否", default: true },
            { from: "b3", to: "be" },
          ],
        },
        outputs: [{ name: "drafts", type: "array", description: "回复草稿" }],
      },
      { id: "n3", type: "step", title: "确认发送", executor: "human", instructions: "请用户确认草稿", action: { kind: "human", message: "请确认", approval: true } },
      { id: "e", type: "end", title: "结束", outputs: [{ name: "drafts", from: "n2.drafts" }] },
    ],
    edges: [
      { from: "s", to: "n1" },
      { from: "n1", to: "n2" },
      { from: "n2", to: "n3" },
      { from: "n3", to: "e" },
    ],
  });

describe("对话提示词导出", () => {
  it("输出完整版和精简版两个文件，路径用 slug 命名", () => {
    const files = promptExporter.compile(lower(v2Sample()), {});
    expect(files.map((f) => f.path)).toEqual(["weekly-order-check.prompt.md", "weekly-order-check.prompt-short.md"]);
  });

  it("去掉给 Skill 触发用的「……时使用」句子", () => {
    const md = renderPrompt(nested());
    expect(md).toContain("整理客户反馈并生成回复草稿。\n");
    expect(md).not.toContain("时使用");
  });

  it("HTTP 步骤标记为需要用户操作，人工步骤标记为需要确认，大模型步骤不标", () => {
    const md = renderPrompt(nested());
    expect(md).toContain("1. **拉取订单**〔需要用户操作〕");
    expect(md).toContain("3. **确认发送**〔需要确认〕");
    expect(md).toMatch(/\*\*起草回复\*\* 写一段回复/);
    expect(md).not.toMatch(/起草回复\*\*〔/);
  });

  it("循环的子步骤带前缀编号，分支跳转和结束语都只针对本轮", () => {
    const md = renderPrompt(nested());
    expect(md).toContain("2. **逐条处理反馈** 对「拉取订单」的「订单列表」中的每一项，依次完成下面的子步骤。输出：`drafts`（array，回复草稿）。完成后进入第 3 步。");
    expect(md).toContain("   2.1. **判断是否需要跟进** 看订单状态。");
    expect(md).toContain("   2.2. **判断：需要跟进？**");
    expect(md).toContain("     - 是（条件：「判断是否需要跟进」的「是否需要跟进」为真） → 第 2.3 步");
    expect(md).toContain("     - 否（其他情况） → 本项结束");
    expect(md).toContain("   2.3. **起草回复** 写一段回复。具体要求：写回复。本项完成，继续循环中的下一项。");
    expect(md).toContain("3. **确认发送**〔需要确认〕 请用户确认草稿。暂停，等用户回复后再继续。至此流程结束。");
  });

  it("有输入和最终交付时才写对应段落", () => {
    const md = renderPrompt(nested());
    expect(md).toContain("## 开始前需要确认的事项");
    expect(md).toContain("- 「拉取订单」：`items`（订单列表）");
    expect(md).toContain("## 最终交付");
    expect(md).toContain("- 「逐条处理反馈」的「回复草稿」");
    expect(md).not.toContain("## 需要用户提供的输入");
    expect(md).toContain("先简单说明要做什么，再按「开始前需要确认的事项」一次问完，然后从第 1 步开始。");

    const sample = renderPrompt(v2Sample());
    expect(sample).toContain("## 需要用户提供的输入");
    expect(sample).toContain("- `week`（必填）：周次");
    expect(sample).not.toContain("## 最终交付");
  });

  it("定时触发在开始方式中说明改为手动发起，并给出有损提示", () => {
    const md = renderPrompt(v2Sample());
    expect(md).toContain("这个流程原本是「每周五 17:00」自动执行的，在对话中改为由用户手动发起。");
    const issues = checkExport(promptExporter, lower(v2Sample()));
    expect(issues.some((i) => i.level === "warning" && i.message.includes("「定时触发」导出后会有损失"))).toBe(true);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("并行分支给出有损提示；人工流程（process）可以导出", () => {
    const parallel = base({
      nodes: [
        { id: "s", type: "start", title: "开始" },
        { id: "a", type: "step", title: "甲", executor: "llm", instructions: "做甲" },
        { id: "b", type: "step", title: "乙", executor: "llm", instructions: "做乙" },
        { id: "m", type: "merge", title: "汇合" },
        { id: "e", type: "end", title: "结束" },
      ],
      edges: [
        { from: "s", to: "a" },
        { from: "s", to: "b" },
        { from: "a", to: "m" },
        { from: "b", to: "m" },
        { from: "m", to: "e" },
      ],
    });
    expect(checkExport(promptExporter, lower(parallel)).some((i) => i.level === "warning" && i.message.includes("「并行分支」"))).toBe(true);

    const process = base({ kind: "process", nodes: [{ id: "s", type: "start", title: "开始" }, { id: "a", type: "step", title: "审批", executor: "human", instructions: "审批材料" }, { id: "e", type: "end", title: "结束" }], edges: [{ from: "s", to: "a" }, { from: "a", to: "e" }] });
    expect(checkExport(promptExporter, lower(process)).filter((i) => i.level === "error")).toEqual([]);
  });

  it("每一种能力都有声明，导出时不会因为未声明而报错", () => {
    for (const f of Object.keys(FEATURE_LABELS)) expect(promptExporter.capabilities[f as keyof typeof FEATURE_LABELS], f).toBeDefined();
  });
});

describe("对话提示词的质量：适配普通聊天窗口", () => {
  it("描述里的版本备注不进入提示词", () => {
    const md = renderPrompt({ ...v2Sample(), description: "每周检查订单。（v2：增加预览确认）当用户需要检查时使用。" });
    expect(md).toContain("每周检查订单。\n");
    expect(md).not.toContain("v2");
  });

  it("说明 AI 在聊天窗口里的能力边界", () => {
    expect(renderPrompt(v2Sample())).toContain("无法登录或访问任何系统，无法联网，无法运行代码");
  });

  it("用户操作的步骤改写成请用户去做，并说明要贴回什么，不再写给程序看的说明", () => {
    const md = renderPrompt(nested());
    expect(md).toContain("1. **拉取订单**〔需要用户操作〕 请你在相关系统中完成：调用 ERP 查询订单。请把`items`（订单列表）粘贴到对话里，我再继续。");
    expect(md).not.toContain("输出：`items`");
    // 原工作流不被修改
    expect(nested().nodes[1]).toMatchObject({ instructions: "调用 ERP 查询订单" });
  });

  it("判断分支没有写明标准时，提醒先向用户确认", () => {
    // 与演示工作流一样：分支只有「有 / 没有」的标签，没有任何条件
    const noCriteria = base({
      nodes: [
        { id: "s", type: "start", title: "开始" },
        { id: "d", type: "decision", title: "有异常订单？", mode: "expr" },
        { id: "a", type: "step", title: "处理异常", executor: "llm", instructions: "处理" },
        { id: "b", type: "step", title: "直接汇总", executor: "llm", instructions: "汇总" },
        { id: "e", type: "end", title: "结束" },
      ],
      edges: [
        { from: "s", to: "d" },
        { from: "d", to: "a", label: "有" },
        { from: "d", to: "b", label: "没有" },
        { from: "a", to: "e" },
        { from: "b", to: "e" },
      ],
    });
    const md = renderPrompt(noCriteria);
    expect(md).toContain("**判断：有异常订单？（判断标准未写明，请先向用户确认）**");
    expect(md).not.toContain("判断问题");
    // 有条件的判断不提醒
    expect(renderPrompt(nested())).not.toContain("判断标准未写明");
  });

  it("精简版不超过 2000 字符，且保留用户操作步骤的完整说明", () => {
    const md = renderPrompt(nested(), { variant: "short" });
    expect(md.length).toBeLessThanOrEqual(2000);
    expect(md).toContain("请把`items`（订单列表）粘贴到对话里，我再继续。");
    expect(md).not.toContain("## 你的工作环境\n\n你在普通聊天窗口里工作：无法登录或访问任何系统");
    expect(renderPrompt(v2Sample(), { variant: "short" }).length).toBeLessThanOrEqual(2000);
  });

  it("执行约定包含进度、缺数据和数据过长的处理", () => {
    const md = renderPrompt(nested());
    expect(md).toContain("每次回复开头用一行标明当前进度");
    expect(md).toContain("用户没有提供的数据不要假设或补全");
    expect(md).toContain("分批发送");
    expect(md).toContain("需要的模板或格式缺失时，请用户给出");
  });
});

describe("聊天场景操作说明 chatInstructions", () => {
  const withChat = (chat?: string): WorkflowIR => {
    const ir = nested();
    const n1 = ir.nodes.find((n) => n.id === "n1");
    if (n1?.type === "step" && chat) n1.chatInstructions = chat;
    return ir;
  };

  it("有 chatInstructions 时直接使用，不再拼接「调用…接口」式的说明", () => {
    const text = renderPrompt(withChat("在 ERP 的订单查询里导出本周订单"));
    expect(text).toContain("请你在 ERP 的订单查询里导出本周订单。请把");
    expect(text).not.toContain("调用 ERP 查询订单");
  });

  it("没有 chatInstructions（旧工作流）时保持原有行为", () => {
    const text = renderPrompt(withChat());
    expect(text).toContain("请你在相关系统中完成：调用 ERP 查询订单");
  });
});

describe("导出前补缺口", () => {
  const gapFlow = (): WorkflowIR =>
    base({
      nodes: [
        { id: "s", type: "start", title: "开始" },
        { id: "d1", type: "decision", title: "有异常订单？", mode: "llm" },
        { id: "n1", type: "step", title: "生成周报", executor: "llm", instructions: "按模板汇总销售额", action: { kind: "llm", prompt: "按模板生成周报" } },
        { id: "e", type: "end", title: "结束" },
      ],
      edges: [
        { from: "s", to: "d1" },
        { from: "d1", to: "n1", label: "有" },
        { from: "d1", to: "n1", label: "没有", default: true },
        { from: "n1", to: "e" },
      ],
    });

  it("列出判断标准和模板两类缺口，带上节点 id", () => {
    const g = promptGaps(gapFlow());
    expect(g.map((x) => [x.nodeId, x.kind])).toEqual([
      ["d1", "criteria"],
      ["n1", "template"],
    ]);
  });

  it("补充后缺口消失，提示词不再要求先问，并把答案写进步骤", () => {
    const ir = applyPromptAnswers(gapFlow(), { d1: "金额超过 1 万或状态为 abnormal", n1: "三段：本周销售额、环比、Top3 客户" });
    expect(promptGaps(ir)).toEqual([]);
    const full = renderPrompt(ir);
    expect(full).not.toContain("开始前需要确认的事项");
    expect(full).toContain("金额超过 1 万或状态为 abnormal");
    expect(full).toContain("必须按用户确认的模板或格式输出：三段：本周销售额、环比、Top3 客户");
    expect(renderPrompt(ir, { variant: "short" })).toContain("三段：本周销售额、环比、Top3 客户");
  });

  it("空白回答被忽略，原工作流不被修改", () => {
    const src = gapFlow();
    const ir = applyPromptAnswers(src, { d1: "   ", n1: "" });
    expect(promptGaps(ir)).toHaveLength(2);
    applyPromptAnswers(src, { n1: "模板" });
    expect(promptGaps(src)).toHaveLength(2);
  });
});

describe("文字细节", () => {
  it("说明以句号结尾时不会出现「。。」", () => {
    const ir = base({
      nodes: [
        { id: "s", type: "start", title: "开始" },
        { id: "n1", type: "step", title: "写报告", executor: "llm", instructions: "汇总数据生成报告。", action: { kind: "llm", prompt: "按要求写一份报告。" } },
        { id: "e", type: "end", title: "结束" },
      ],
      edges: [
        { from: "s", to: "n1" },
        { from: "n1", to: "e" },
      ],
    });
    expect(renderPrompt(ir)).not.toContain("。。");
  });

  it("条件右侧写成对变量的引用时，翻译成人话而不是原样输出", () => {
    const withRef = base({
      nodes: [
        { id: "s", type: "start", title: "开始" },
        { id: "d1", type: "decision", title: "金额一致？", mode: "expr" },
        { id: "a", type: "step", title: "通过", executor: "llm", instructions: "登记通过", action: { kind: "llm", prompt: "登记通过" } },
        { id: "b", type: "step", title: "驳回", executor: "llm", instructions: "登记驳回", action: { kind: "llm", prompt: "登记驳回" } },
        { id: "e", type: "end", title: "结束" },
      ],
      edges: [
        { from: "s", to: "d1" },
        { from: "d1", to: "a", label: "一致", condition: { left: "input.amount", op: "eq", right: "input.invoice_amount" } },
        { from: "d1", to: "b", label: "不一致", default: true },
        { from: "a", to: "e" },
        { from: "b", to: "e" },
      ],
      inputs: [{ name: "amount", type: "number", description: "金额", required: true }, { name: "invoice_amount", type: "number", description: "发票金额", required: true }],
    });
    const out = renderPrompt(withRef);
    expect(out).toContain("等于 用户提供的「invoice_amount」");
    expect(out).not.toContain("input.invoice_amount");
  });
});
