import { migrateIr, type WorkflowIR, type WorkflowIRv1 } from "@aif/workflow-ir";

/** 带 foreach 子流程的报销核对：子流程里有数据整理、代码、人工复核三种步骤 */
export const loopIr = (): WorkflowIR => ({
  version: 2,
  kind: "automation",
  slug: "expense-check",
  name: "报销单核对",
  description: "逐条核对报销单金额与发票是否一致。当用户需要核对报销单时使用。",
  trigger: { type: "manual", detail: "用户主动要求核对报销单时" },
  inputs: [{ name: "expense_list", type: "array", items: "object", description: "报销单列表", required: true }],
  integrations: [],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    {
      id: "n_split",
      type: "foreach",
      title: "逐条核对",
      over: "input.expense_list",
      item: "expense",
      body: {
        nodes: [
          { id: "bs", type: "start", title: "开始" },
          {
            id: "calc",
            type: "step",
            title: "生成单号摘要",
            executor: "deterministic",
            instructions: "拼出单号摘要",
            action: { kind: "transform", template: "单号 {{expense.id}}" },
            outputs: [{ name: "label", type: "string", description: "单号摘要" }],
          },
          {
            id: "diff",
            type: "step",
            title: "计算差额",
            executor: "deterministic",
            instructions: "计算报销金额与发票金额的差额",
            action: {
              kind: "code",
              language: "javascript",
              source: 'const row = $input.first().json;\nreturn [{ json: { summary: row.label + "!" } }];',
            },
            outputs: [{ name: "summary", type: "string", description: "差额说明" }],
          },
          { id: "ok", type: "step", title: "复核差额", executor: "human", instructions: "请财务复核差额", action: { kind: "human", message: "请复核 {{expense.id}}", approval: true } },
          { id: "be", type: "end", title: "结束" },
        ],
        edges: [
          { from: "bs", to: "calc" },
          { from: "calc", to: "diff" },
          { from: "diff", to: "ok" },
          { from: "ok", to: "be" },
        ],
      },
      outputs: [{ name: "results", type: "array", items: "string", description: "每张单据的核对结论" }],
    },
    {
      id: "n_report",
      type: "step",
      title: "生成核对结果表",
      executor: "llm",
      instructions: "汇总核对结论",
      action: { kind: "llm", prompt: "根据 {{n_split.results}} 生成核对结果表" },
    },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n_split" },
    { from: "n_split", to: "n_report" },
    { from: "n_report", to: "e" },
  ],
  source: { painPointIds: [] },
});

/** 带判断分支和人工确认、但确定性步骤没有脚本的销售周报（v1 迁移而来） */
export const salesIr = (): WorkflowIR =>
  migrateIr({
    version: 1,
    kind: "automation",
    slug: "weekly-sales-report",
    name: "销售周报自动汇总",
    description: "每周汇总 ERP 订单数据并生成销售周报。当用户需要写周报时使用。",
    trigger: { type: "schedule", detail: "每周五 17:00", cron: "0 17 * * 5" },
    inputs: [],
    integrations: [{ id: "erp", name: "ERP", purpose: "拉取本周订单", access: "api" }],
    nodes: [
      { id: "s", type: "start", title: "开始" },
      { id: "n1", type: "step", title: "拉取本周订单", executor: "deterministic", integration: "erp", instructions: "调用 ERP 订单接口" },
      { id: "n2", type: "decision", title: "有异常订单？" },
      { id: "n3", type: "step", title: "人工核对异常", executor: "human", instructions: "列出异常订单，请用户确认" },
      { id: "n4", type: "step", title: "生成周报", executor: "llm", instructions: "按模板汇总" },
      { id: "e", type: "end", title: "结束" },
    ],
    edges: [
      { from: "s", to: "n1" },
      { from: "n1", to: "n2" },
      { from: "n2", to: "n3", label: "有" },
      { from: "n2", to: "n4", label: "没有" },
      { from: "n3", to: "n4" },
      { from: "n4", to: "e" },
    ],
    source: { painPointIds: [] },
  } satisfies WorkflowIRv1);
