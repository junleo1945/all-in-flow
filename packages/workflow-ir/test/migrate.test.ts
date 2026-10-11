import { describe, expect, it } from "vitest";
import { migrateIr, validateWorkflow, type WorkflowIR } from "../src/index.js";
import { salesReport } from "./fixtures.js";

describe("v1 → v2 迁移", () => {
  it("结构转换：版本号、输入类型、判断节点、步骤输出", () => {
    const ir = migrateIr(salesReport);
    expect(ir.version).toBe(2);
    expect(ir.inputs).toEqual([]);

    const decision = ir.nodes.find((n) => n.id === "n2")!;
    expect(decision).toEqual({ id: "n2", type: "decision", title: "有异常订单？", mode: "llm", question: "有异常订单？" });

    const step = ir.nodes.find((n) => n.id === "n1")!;
    expect(step).toMatchObject({ type: "step", executor: "deterministic", integration: "erp", outputs: [] });
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

  it("v2 数据原样返回，不重复转换", () => {
    const v2: WorkflowIR = migrateIr(salesReport);
    expect(migrateIr(v2)).toBe(v2);
  });

  it("迁移不修改原始对象", () => {
    const before = JSON.stringify(salesReport);
    migrateIr(salesReport);
    expect(JSON.stringify(salesReport)).toBe(before);
  });
});
