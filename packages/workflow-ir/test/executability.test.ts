import { describe, expect, it } from "vitest";
import { checkWorkflow, codeProblem, executability, isSimpleTemplate, type WorkflowIR } from "../src/index.js";

const base = (nodes: WorkflowIR["nodes"]): WorkflowIR => ({
  version: 2,
  kind: "automation",
  slug: "exe",
  name: "可执行性",
  description: "检查数据整理是否可执行。当需要检查时使用。",
  trigger: { type: "manual", detail: "手动" },
  inputs: [],
  nodes: [{ id: "s", type: "start", title: "开始" }, ...nodes, { id: "e", type: "end", title: "结束" }],
  edges: [
    { from: "s", to: nodes[0]!.id },
    ...nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })),
    { from: nodes[nodes.length - 1]!.id, to: "e" },
  ],
  source: { painPointIds: [] },
});

const step = (id: string, action: unknown) => ({ id, type: "step", title: id, executor: "deterministic", instructions: id, action }) as WorkflowIR["nodes"][number];

describe("isSimpleTemplate", () => {
  it("字段拼接是简单模板，一句话的处理指令不是", () => {
    expect(isSimpleTemplate("订单 {{n1.id}} 金额 {{n1.amount}}")).toBe(true);
    expect(isSimpleTemplate("{{n1.name}}")).toBe(true);
    expect(isSimpleTemplate("对订单逐行判断金额是否异常，异常的标出来")).toBe(false);
    expect(isSimpleTemplate("按销售分组汇总金额，然后排序。")).toBe(false);
  });
});

describe("codeProblem", () => {
  it("正常的数据处理代码没有问题", () => {
    expect(codeProblem("const rows = $input.first().json.orders; return [{ json: { total: rows.length } }];")).toBeUndefined();
  });

  it("访问文件、子进程、环境变量、动态执行或过长的代码被拒绝", () => {
    for (const bad of ["require('fs')", "process.env.KEY", "fs.readFileSync('x')", "eval('1')", "new Function('x')", "child_process.exec('ls')"]) {
      expect(codeProblem(bad), bad).toBeDefined();
    }
    expect(codeProblem("x".repeat(4001))).toContain("过长");
  });
});

describe("executability", () => {
  it("统计 transform 与 code 步骤，以及其中描述式整理与不安全代码的数量", () => {
    const ir = base([
      step("a", { kind: "transform", template: "订单 {{input.id}}" }),
      step("b", { kind: "transform", template: "对订单逐行判断金额是否异常，异常的标出来" }),
      step("c", { kind: "code", language: "javascript", source: "return [{ json: { total: 1 } }];" }),
      step("d", { kind: "code", language: "javascript", source: "require('fs')" }),
    ]);
    expect(executability(ir)).toEqual({ transformSteps: 2, descriptiveTransforms: 1, codeSteps: 2, unsafeCode: 1 });
  });
});

describe("校验：code 步骤", () => {
  it("不安全的 JavaScript 代码是错误", () => {
    const ir = base([step("d", { kind: "code", language: "javascript", source: "require('fs')" })]);
    expect(checkWorkflow(ir).some((i) => i.level === "error" && i.message.includes("不允许"))).toBe(true);
  });

  it("安全的代码通过校验", () => {
    const ir = base([step("c", { kind: "code", language: "javascript", source: "return [{ json: { total: 1 } }];" })]);
    expect(checkWorkflow(ir).filter((i) => i.level === "error")).toEqual([]);
  });
});
