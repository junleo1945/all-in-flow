import type { WorkflowIR } from "../src/index.js";

/** 输入、API 调用、foreach 子流程、expr 判断、人工确认、LLM 生成 */
export const v2Sample = (): WorkflowIR => ({
  version: 2,
  kind: "automation",
  slug: "weekly-order-check",
  name: "订单周检",
  description: "每周检查 ERP 订单并生成周报。当用户需要检查本周订单时使用。",
  trigger: { type: "schedule", detail: "每周五 17:00", cron: "0 17 * * 5" },
  inputs: [{ name: "week", type: "string", description: "周次", required: true }],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    {
      id: "n1",
      type: "step",
      title: "拉取本周订单",
      executor: "deterministic",
      instructions: "调用 ERP 查询订单",
      action: { kind: "http", method: "GET", url: "https://erp.example.com/api/orders?week={{input.week}}" },
      outputs: [{ name: "orders", type: "array", description: "订单列表" }],
    },
    {
      id: "n2",
      type: "foreach",
      title: "逐条核对订单",
      over: "n1.orders",
      item: "order",
      body: {
        nodes: [
          { id: "bs", type: "start", title: "开始" },
          {
            id: "b1",
            type: "step",
            title: "核对单笔订单",
            executor: "llm",
            instructions: "判断订单是否异常",
            action: { kind: "llm", prompt: "判断订单 {{order.id}} 是否异常" },
            outputs: [{ name: "abnormal", type: "boolean", description: "是否异常" }],
          },
          { id: "be", type: "end", title: "结束" },
        ],
        edges: [
          { from: "bs", to: "b1" },
          { from: "b1", to: "be" },
        ],
      },
      outputs: [{ name: "results", type: "array", description: "核对结果" }],
    },
    {
      id: "n3",
      type: "decision",
      title: "有异常订单？",
      mode: "expr",
    },
    {
      id: "n4",
      type: "step",
      title: "人工确认异常",
      executor: "human",
      instructions: "请用户确认异常订单是否计入",
      action: { kind: "human", message: "请确认 {{n2.results}}", approval: true },
    },
    {
      id: "n5",
      type: "step",
      title: "生成周报",
      executor: "llm",
      instructions: "汇总订单核对结果",
      action: { kind: "llm", prompt: "汇总 {{n2.results}}" },
    },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
    { from: "n3", to: "n4", label: "有异常", condition: { left: "n2.results", op: "not_empty" } },
    { from: "n3", to: "n5", label: "没有", default: true },
    { from: "n4", to: "n5" },
    { from: "n5", to: "e" },
  ],
  source: { painPointIds: ["p1"] },
});
