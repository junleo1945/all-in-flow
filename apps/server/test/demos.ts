import type { WorkflowIR } from "@aif/workflow-ir";
import { salesReportV1 } from "./fixtures.js";

/**
 * 演示用的工作流集合：每一个覆盖一类结构，演示和全链路测试共用。
 * 都是 Workflow IR v2，必须能通过 validateWorkflow（demoE2E.test.ts 会逐个校验）。
 */

/** 1. 销售周报：定时触发 + 接口取数 + 条件分支 + 人工确认 + 大模型成文（最典型的自动化） */
export const weeklySalesReport: WorkflowIR = {
  version: 2,
  kind: "automation",
  slug: "weekly-sales-report",
  name: "销售周报自动汇总",
  description: "每周五汇总 ERP 本周订单，异常订单经人工确认后生成销售周报。当用户需要写周报或汇总本周销售数据时使用。",
  trigger: { type: "schedule", detail: "每周五 17:00", cron: "0 17 * * 5" },
  inputs: [{ name: "week", type: "string", description: "周次，例如 2026-W43", required: true }],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    {
      id: "n1",
      type: "step",
      title: "拉取本周订单",
      executor: "deterministic",
      instructions: "从 ERP 查询本周一 00:00 到现在的全部订单",
      chatInstructions: "打开 ERP 的订单查询页面，把下单时间设为本周一 00:00 到现在，点击查询后导出订单列表。",
      action: { kind: "http", method: "GET", url: "https://erp.example.com/api/orders?week={{input.week}}" },
      outputs: [
        {
          name: "orders",
          type: "array",
          description: "订单列表",
          fields: [
            { name: "id", description: "订单号" },
            { name: "amount", description: "订单金额" },
            { name: "status", description: "订单状态" },
          ],
        },
      ],
    },
    {
      id: "n2",
      type: "step",
      title: "筛出异常订单",
      executor: "deterministic",
      instructions: "挑出状态为 abnormal 的订单",
      action: { kind: "code", language: "javascript", source: "return orders.filter((o) => o.status === 'abnormal');" },
      outputs: [{ name: "abnormal", type: "array", description: "异常订单" }],
    },
    { id: "n3", type: "decision", title: "有异常订单？", mode: "expr" },
    {
      id: "n4",
      type: "step",
      title: "人工确认异常订单",
      executor: "human",
      instructions: "列出异常订单，请用户确认是否计入本周销售额",
      action: { kind: "human", message: "请确认以下异常订单是否计入：{{n2.abnormal}}", approval: true },
    },
    {
      id: "n5",
      type: "step",
      title: "生成销售周报",
      executor: "llm",
      instructions: "按模板汇总销售额、环比、Top 客户，并写三条结论",
      template: "一、本周销售额与环比\n二、Top 5 客户\n三、三条结论",
      action: { kind: "llm", prompt: "根据 {{n1.orders}} 生成销售周报" },
    },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
    { from: "n3", to: "n4", label: "有", condition: { left: "n2.abnormal", op: "not_empty" } },
    { from: "n3", to: "n5", label: "没有", default: true },
    { from: "n4", to: "n5" },
    { from: "n5", to: "e" },
  ],
  source: { painPointIds: ["p1"], savedMinutesPerWeek: 150 },
};

/** 2. 客户反馈分诊：事件触发 + 循环（内含分支）+ 大模型分类与起草 + 人工确认发送 */
export const feedbackTriage: WorkflowIR = {
  version: 2,
  kind: "automation",
  slug: "customer-feedback-triage",
  name: "客户反馈分诊与回复",
  description: "收到客户反馈后逐条分类，需要跟进的起草回复并经人确认后发送。当用户需要批量处理客户反馈时使用。",
  trigger: { type: "event", detail: "客服邮箱收到新反馈" },
  inputs: [{ name: "feedbacks", type: "array", items: "object", description: "待处理的客户反馈", required: true }],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    {
      id: "n1",
      type: "foreach",
      title: "逐条处理反馈",
      over: "input.feedbacks",
      item: "fb",
      body: {
        nodes: [
          { id: "bs", type: "start", title: "开始" },
          {
            id: "b1",
            type: "step",
            title: "判断是否需要跟进",
            executor: "llm",
            instructions: "阅读反馈，判断是投诉、咨询还是表扬，投诉和咨询需要跟进",
            action: { kind: "llm", prompt: "判断反馈类型：{{fb.text}}" },
            outputs: [{ name: "needFollowUp", type: "boolean", description: "是否需要跟进" }],
          },
          { id: "b2", type: "decision", title: "需要跟进？", mode: "expr" },
          {
            id: "b3",
            type: "step",
            title: "起草回复",
            executor: "llm",
            instructions: "用礼貌、简洁的语气写一段回复草稿",
            action: { kind: "llm", prompt: "为这条反馈起草回复：{{fb.text}}" },
            outputs: [{ name: "draft", type: "string", description: "回复草稿" }],
          },
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
      outputs: [{ name: "drafts", type: "array", description: "回复草稿汇总" }],
    },
    {
      id: "n2",
      type: "step",
      title: "确认并发送",
      executor: "human",
      instructions: "逐条查看回复草稿，确认后再发送",
      action: { kind: "human", message: "请确认回复草稿：{{n1.drafts}}", approval: true },
    },
    { id: "e", type: "end", title: "结束", outputs: [{ name: "drafts", from: "n1.drafts" }] },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "n2" },
    { from: "n2", to: "e" },
  ],
  source: { painPointIds: ["p2"], savedMinutesPerWeek: 120 },
};

/** 3. 报销核对：纯流程（process）+ 人工步骤 + 多分支汇合（merge），没有可自动化的动作 */
export const expenseReview: WorkflowIR = {
  version: 2,
  kind: "process",
  slug: "expense-review",
  name: "报销单核对流程",
  description: "财务收到报销单后核对金额与票据，按金额走不同审批。当用户需要梳理或培训报销核对流程时使用。",
  trigger: { type: "manual", detail: "财务收到报销单时" },
  inputs: [],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    { id: "n1", type: "step", title: "核对票据", executor: "human", instructions: "对照发票检查报销单上的金额、日期和事由" },
    { id: "n2", type: "decision", title: "金额超过 5000？", mode: "llm", question: "报销金额是否超过 5000 元？" },
    { id: "n3", type: "step", title: "部门负责人审批", executor: "human", instructions: "把报销单交给部门负责人签字" },
    { id: "n4", type: "step", title: "财务总监审批", executor: "human", instructions: "把报销单和票据交给财务总监复核并签字" },
    { id: "m", type: "merge", title: "审批完成" },
    { id: "n5", type: "step", title: "登记并付款", executor: "human", instructions: "在财务系统登记并安排付款" },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3", label: "否" },
    { from: "n2", to: "n4", label: "是" },
    { from: "n3", to: "m" },
    { from: "n4", to: "m" },
    { from: "m", to: "n5" },
    { from: "n5", to: "e" },
  ],
  source: { painPointIds: ["p3"] },
};

/** 4. 晨间邮件：前半段是人的行为（到公司），后半段可自动化；用于验证「切段」和 n8n / Skill 导出 */
export const morningMail: WorkflowIR = {
  version: 2,
  kind: "automation",
  slug: "morning-mail-digest",
  name: "晨间邮件摘要",
  description: "每天早上读取新邮件，提炼要点后发到钉钉群。当用户需要每天汇总邮件时使用。",
  trigger: { type: "schedule", detail: "工作日 08:30", cron: "30 8 * * 1-5" },
  inputs: [],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    { id: "n1", type: "step", title: "到公司", executor: "human", instructions: "每天早上 8:30 到公司", action: { kind: "human", message: "到公司" } },
    {
      id: "n2",
      type: "step",
      title: "读取新邮件",
      executor: "deterministic",
      instructions: "读取邮箱里昨天 18:00 之后的新邮件",
      action: { kind: "http", method: "GET", url: "https://mail.example.com/api/messages?since=yesterday-18" },
      outputs: [{ name: "mails", type: "array", description: "新邮件" }],
    },
    {
      id: "n3",
      type: "step",
      title: "提炼要点",
      executor: "llm",
      instructions: "每封邮件提炼一句话要点，标出需要今天回复的",
      action: { kind: "llm", prompt: "提炼要点：{{n2.mails}}" },
      outputs: [{ name: "digest", type: "string", description: "邮件摘要" }],
    },
    {
      id: "n4",
      type: "step",
      title: "发到钉钉群",
      executor: "deterministic",
      instructions: "把摘要发到团队钉钉群",
      action: { kind: "http", method: "POST", url: "https://oapi.dingtalk.example.com/robot/send", body: "{\"text\":\"{{n3.digest}}\"}" },
    },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
    { from: "n3", to: "n4" },
    { from: "n4", to: "e" },
  ],
  source: { painPointIds: ["p4"], savedMinutesPerWeek: 60 },
};

/** 演示集合（v2）：名称用于测试标题 */
export const DEMOS: Array<{ key: string; ir: WorkflowIR }> = [
  { key: "销售周报", ir: weeklySalesReport },
  { key: "客户反馈分诊", ir: feedbackTriage },
  { key: "报销核对", ir: expenseReview },
  { key: "晨间邮件", ir: morningMail },
];

/** 旧版（v1）数据：用于验证读取时的迁移 */
export const LEGACY_V1 = salesReportV1;

/** 故意写坏的工作流：每一个都必须被校验器拒绝，且给出可读的原因 */
const clone = <T>(v: T): T => structuredClone(v);
export const BROKEN: Array<{ key: string; ir: unknown; expect: RegExp }> = [
  {
    key: "缺少结束节点的连线（流程走不到结束）",
    ir: { ...clone(weeklySalesReport), edges: weeklySalesReport.edges.filter((e) => e.to !== "e") },
    expect: /无法到达任何 end/,
  },
  {
    key: "孤立节点（从开始走不到）",
    ir: { ...clone(morningMail), nodes: [...morningMail.nodes, { id: "x", type: "step", title: "孤岛", executor: "human", instructions: "没人连到我" }] },
    expect: /无法从 start 到达/,
  },
  {
    key: "slug 不是 kebab-case 英文",
    ir: { ...clone(expenseReview), slug: "报销 核对" },
    expect: /kebab-case/,
  },
  {
    key: "step 缺少 instructions",
    ir: {
      ...clone(morningMail),
      nodes: morningMail.nodes.map((n) => (n.id === "n3" ? { ...n, instructions: "" } : n)),
    },
    expect: /instructions/,
  },
  {
    key: "不是对象",
    ir: "这不是一个工作流",
    expect: /只支持 1 或 2/,
  },
];
