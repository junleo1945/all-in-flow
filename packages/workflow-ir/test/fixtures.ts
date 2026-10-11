import type { WorkflowIR } from "../src/index.js";

/** 设计文档 6.4 的示例：销售周报 */
export const salesReport: WorkflowIR = {
  version: 1,
  kind: "automation",
  slug: "weekly-sales-report",
  name: "销售周报自动汇总",
  description: "每周汇总 ERP 订单数据并生成销售周报。当用户需要写周报或汇总本周销售数据时使用。",
  trigger: { type: "schedule", detail: "每周五 17:00", cron: "0 17 * * 5" },
  inputs: [],
  integrations: [
    { id: "erp", name: "ERP", purpose: "拉取本周订单", access: "api", hint: "需要环境变量 ERP_TOKEN" },
  ],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    { id: "n1", type: "step", title: "拉取本周订单", executor: "deterministic", integration: "erp", instructions: "调用 ERP 订单接口，时间范围为本周一 00:00 到现在" },
    { id: "n2", type: "decision", title: "有异常订单？" },
    { id: "n3", type: "step", title: "人工核对异常", executor: "human", instructions: "列出异常订单，请用户确认是否计入" },
    { id: "n4", type: "step", title: "生成周报", executor: "llm", instructions: "按模板汇总销售额、环比、Top 客户，并写三条结论" },
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
  source: { painPointIds: ["p1", "p3"], savedMinutesPerWeek: 90 },
};
