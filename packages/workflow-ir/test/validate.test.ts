import { describe, expect, it } from "vitest";
import { validateWorkflow, type WorkflowIR } from "../src/index.js";
import { salesReport } from "./fixtures.js";

const clone = (): WorkflowIR => structuredClone(salesReport);

describe("validateWorkflow", () => {
  it("accepts the sample workflow", () => {
    const r = validateWorkflow(salesReport);
    expect(r.ok).toBe(true);
  });

  it("rejects a step without executor or instructions", () => {
    const ir = clone();
    const step = ir.nodes.find((n) => n.id === "n4")!;
    delete step.executor;
    delete step.instructions;
    const r = validateWorkflow(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.message).join("\n")).toMatch(/executor|instructions/);
  });

  it("rejects a decision edge without label", () => {
    const ir = clone();
    ir.edges.find((e) => e.from === "n2")!.label = undefined;
    const r = validateWorkflow(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.message.includes("label"))).toBe(true);
  });

  it("rejects a node that cannot be reached from start", () => {
    const ir = clone();
    ir.nodes.push({ id: "orphan", type: "step", title: "孤立", executor: "llm", instructions: "x" });
    const r = validateWorkflow(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.nodeId === "orphan")).toBe(true);
  });

  it("allows a loop that passes through a decision", () => {
    const ir = clone();
    // n4 -> n2 形成循环，循环经过 decision n2
    ir.edges.push({ from: "n4", to: "n2" });
    const r = validateWorkflow(ir);
    expect(r.ok).toBe(true);
  });

  it("rejects a loop with no decision as exit", () => {
    const ir = clone();
    ir.nodes.push({ id: "a", type: "step", title: "A", executor: "llm", instructions: "a" });
    ir.nodes.push({ id: "b", type: "step", title: "B", executor: "llm", instructions: "b" });
    ir.edges.push({ from: "n1", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "a" });
    const r = validateWorkflow(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.message.includes("循环"))).toBe(true);
  });

  it("rejects an invalid kebab-case slug", () => {
    const ir = { ...clone(), slug: "Weekly Report" };
    expect(validateWorkflow(ir).ok).toBe(false);
  });
});
