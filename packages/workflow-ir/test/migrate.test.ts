import { describe, expect, it } from "vitest";
import { migrateIr, stripIntegrations, validateWorkflow, type WorkflowIR } from "../src/index.js";
import { v2Sample } from "./fixtures-v2.js";
import { salesReport } from "./fixtures.js";

describe("v1 → v2 迁移", () => {
  it("结构转换：版本号、输入类型、判断节点、步骤输出", () => {
    const ir = migrateIr(salesReport);
    expect(ir.version).toBe(2);
    expect(ir.inputs).toEqual([]);

    const decision = ir.nodes.find((n) => n.id === "n2")!;
    expect(decision).toEqual({ id: "n2", type: "decision", title: "有异常订单？", mode: "llm", question: "有异常订单？" });

    const step = ir.nodes.find((n) => n.id === "n1")!;
    expect(step).toMatchObject({ type: "step", executor: "deterministic", outputs: [] });
  });

  it("边的 label 保留，没有条件表达式", () => {
    const ir = migrateIr(salesReport);
    expect(ir.edges.find((e) => e.from === "n2" && e.to === "n3")).toEqual({ from: "n2", to: "n3", label: "有" });
    expect(ir.edges.some((e) => e.condition || e.default)).toBe(false);
  });

  it("validateWorkflow 接受 v1，并返回需要确认的迁移提示", () => {
    const r = validateWorkflow(salesReport);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(["判断节点「有异常订单？」已按 LLM 判断迁移，请确认判断依据"]);
  });

  it("v1 的 schema 错误照常报告（不做迁移）", () => {
    const bad = structuredClone(salesReport);
    delete bad.nodes.find((n) => n.id === "n4")!.instructions;
    const r = validateWorkflow(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.message).join("\n")).toMatch(/instructions/);
  });

  it("v2 数据内容不变，不重复转换", () => {
    const v2: WorkflowIR = migrateIr(salesReport);
    expect(migrateIr(v2)).toEqual(v2);
  });

  it("迁移不修改原始对象", () => {
    const before = JSON.stringify(salesReport);
    migrateIr(salesReport);
    expect(JSON.stringify(salesReport)).toBe(before);
  });
});

describe("stripIntegrations：清理旧数据里的集成相关内容", () => {
  const legacy = () => ({
    ...v2Sample(),
    integrations: [{ id: "erp", name: "ERP", purpose: "订单", access: "api" }],
    trigger: { type: "event", detail: "收到邮件", integration: "mail", event: "newMail" },
    nodes: [
      { id: "s", type: "start", title: "开始" },
      {
        id: "n1",
        type: "step",
        title: "拉取订单",
        executor: "deterministic",
        integration: "erp",
        instructions: "拉取订单",
        action: { kind: "integration", integration: "erp", operation: "listOrders", params: {} },
        outputs: [{ name: "orders", type: "array", description: "订单列表" }],
      },
      {
        id: "f",
        type: "foreach",
        title: "逐条",
        over: "n1.orders",
        item: "order",
        body: {
          nodes: [
            { id: "bs", type: "start", title: "开始" },
            { id: "b1", type: "step", title: "处理", executor: "deterministic", integration: "erp", instructions: "处理", action: { kind: "integration", integration: "erp", operation: "x", params: {} } },
            { id: "be", type: "end", title: "结束" },
          ],
          edges: [{ from: "bs", to: "b1" }, { from: "b1", to: "be" }],
        },
      },
      { id: "e", type: "end", title: "结束" },
    ],
    edges: [{ from: "s", to: "n1" }, { from: "n1", to: "f" }, { from: "f", to: "e" }],
  });

  it("去掉 integrations、触发器和节点上的集成字段，以及 integration 类型的 action", () => {
    const ir: any = stripIntegrations(legacy());
    expect(ir.integrations).toBeUndefined();
    expect(ir.trigger).toEqual({ type: "event", detail: "收到邮件" });
    const n1 = ir.nodes.find((n: any) => n.id === "n1");
    expect(n1.integration).toBeUndefined();
    expect(n1.action).toBeUndefined();
    expect(n1.instructions).toBe("拉取订单");
    const b1 = ir.nodes.find((n: any) => n.id === "f").body.nodes.find((n: any) => n.id === "b1");
    expect(b1.integration).toBeUndefined();
    expect(b1.action).toBeUndefined();
  });

  it("不修改传入的对象，其他 action 原样保留", () => {
    const input: any = legacy();
    input.nodes[1].action = { kind: "http", method: "GET", url: "https://x.test" };
    const before = JSON.stringify(input);
    const out: any = stripIntegrations(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(out.nodes[1].action).toEqual({ kind: "http", method: "GET", url: "https://x.test" });
  });

  it("migrateIr 与 validateWorkflow 都能接受旧数据", () => {
    const r = validateWorkflow(legacy());
    expect(r.ok ? [] : r.issues).toEqual([]);
    expect((migrateIr(legacy() as any) as any).integrations).toBeUndefined();
  });
});
