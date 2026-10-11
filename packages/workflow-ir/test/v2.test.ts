import { describe, expect, it } from "vitest";
import { toMermaid, validateWorkflow, type ValidateOptions, type WorkflowIR } from "../src/index.js";
import { v2Sample } from "./fixtures-v2.js";

const ERP_OPS: ValidateOptions = {
  resolveOperation: (integration, operation) =>
    integration === "erp" && operation === "listOrders"
      ? {
          params: [
            { name: "start", required: true },
            { name: "end", required: true },
          ],
        }
      : undefined,
};

function errorsOf(ir: unknown, options?: ValidateOptions): string {
  const r = validateWorkflow(ir, options);
  return r.ok ? "" : r.issues.map((i) => i.message).join("\n");
}

describe("IR v2：合法样例", () => {
  it("通过 schema 与图校验（含 foreach、expr 判断、action）", () => {
    const r = validateWorkflow(v2Sample(), ERP_OPS);
    expect(r.ok, r.ok ? "" : r.issues.map((i) => i.message).join("\n")).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("支持 merge：并行分支汇合", () => {
    const ir: WorkflowIR = {
      ...v2Sample(),
      nodes: [
        { id: "s", type: "start", title: "开始" },
        { id: "a", type: "step", title: "分支 A", executor: "llm", instructions: "a", action: { kind: "llm", prompt: "a" } },
        { id: "b", type: "step", title: "分支 B", executor: "llm", instructions: "b", action: { kind: "llm", prompt: "b" } },
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
    };
    expect(validateWorkflow(ir).ok).toBe(true);
  });

  it("toMermaid 能画出 foreach 与 merge", () => {
    expect(toMermaid(v2Sample())).toContain('n2[["逐条核对订单"]]');
    const withMerge: WorkflowIR = {
      ...v2Sample(),
      nodes: [
        { id: "s", type: "start", title: "开始" },
        { id: "m", type: "merge", title: "汇合" },
        { id: "e", type: "end", title: "结束" },
      ],
      edges: [
        { from: "s", to: "m" },
        { from: "m", to: "e" },
      ],
    };
    expect(toMermaid(withMerge)).toContain('{{"汇合"}}');
  });
});

describe("IR v2：校验规则（export-v2.md 3.6）", () => {
  it("expr 判断的出边必须有 condition 或 default", () => {
    const ir = v2Sample();
    ir.edges.find((e) => e.from === "n3" && e.to === "n5")!.default = undefined;
    expect(errorsOf(ir, ERP_OPS)).toMatch(/condition 或 default/);
  });

  it("default 最多一条", () => {
    const ir = v2Sample();
    ir.edges.find((e) => e.from === "n3" && e.to === "n4")!.default = true;
    expect(errorsOf(ir, ERP_OPS)).toMatch(/最多只能有一条 default/);
  });

  it("llm 判断必须有 question", () => {
    const ir = v2Sample();
    ir.nodes.push({ id: "d", type: "decision", title: "是否投诉", mode: "llm" });
    ir.edges.push({ from: "n5", to: "d" });
    ir.edges.push({ from: "d", to: "e", label: "是" }, { from: "d", to: "e", label: "否" });
    expect(errorsOf(ir, ERP_OPS)).toMatch(/question/);
  });

  it("只有 decision 的出边可以带 condition", () => {
    const ir = v2Sample();
    ir.edges.find((e) => e.from === "n5")!.condition = { left: "n2.results", op: "not_empty" };
    expect(errorsOf(ir, ERP_OPS)).toMatch(/只有 decision/);
  });

  it("引用的节点必须在当前节点之前执行", () => {
    const ir = v2Sample();
    // n1 引用 n2 的输出，而 n2 在 n1 之后
    ir.nodes.find((n) => n.id === "n1")!.action = {
      kind: "integration",
      integration: "erp",
      operation: "listOrders",
      params: { start: "{{n2.results}}", end: "{{input.week}}" },
    };
    expect(errorsOf(ir, ERP_OPS)).toMatch(/不在当前节点之前执行/);
  });

  it("引用的输出必须已声明", () => {
    const ir = v2Sample();
    ir.nodes.find((n) => n.id === "n5")!.action = { kind: "llm", prompt: "汇总 {{n1.nothing}}" };
    expect(errorsOf(ir, ERP_OPS)).toMatch(/没有声明输出 nothing/);
  });

  it("引用的工作流输入必须存在", () => {
    const ir = v2Sample();
    ir.nodes.find((n) => n.id === "n5")!.action = { kind: "llm", prompt: "{{input.nope}}" };
    expect(errorsOf(ir, ERP_OPS)).toMatch(/工作流输入不存在/);
  });

  it("子流程的当前元素只能在子流程内使用", () => {
    const ir = v2Sample();
    ir.nodes.find((n) => n.id === "n5")!.action = { kind: "llm", prompt: "{{order.id}}" };
    expect(errorsOf(ir, ERP_OPS)).toMatch(/引用的节点或元素不存在：order/);
  });

  it("子流程不能引用所在 foreach 自己的输出", () => {
    const ir = v2Sample();
    const loop = ir.nodes.find((n) => n.id === "n2") as Extract<WorkflowIR["nodes"][number], { type: "foreach" }>;
    loop.body.nodes.find((n) => n.id === "b1")!.action = { kind: "llm", prompt: "{{n2.results}}" };
    expect(errorsOf(ir, ERP_OPS)).toMatch(/不能引用节点自身的输出/);
  });

  it("foreach 的 over 必须是 array", () => {
    const ir = v2Sample();
    ir.nodes.find((n) => n.id === "n2")!.over = "input.week";
    expect(errorsOf(ir, ERP_OPS)).toMatch(/必须引用 array/);
  });

  it("子流程和主流程一样必须有且只有一个 start", () => {
    const ir = v2Sample();
    const loop = ir.nodes.find((n) => n.id === "n2") as Extract<WorkflowIR["nodes"][number], { type: "foreach" }>;
    loop.body.nodes = loop.body.nodes.filter((n) => n.id !== "bs");
    loop.body.edges = loop.body.edges.filter((e) => e.from !== "bs");
    expect(errorsOf(ir, ERP_OPS)).toMatch(/foreach「逐条核对订单」的子流程：必须且只能有一个 start/);
  });

  it("executor 与 action 类型必须匹配", () => {
    const ir = v2Sample();
    // n5 是 llm，不能使用 integration
    ir.nodes.find((n) => n.id === "n5")!.action = {
      kind: "integration",
      integration: "erp",
      operation: "listOrders",
      params: { start: "{{input.week}}", end: "{{input.week}}" },
    };
    expect(errorsOf(ir, ERP_OPS)).toMatch(/executor 为 llm 时不能使用 integration/);
  });

  it("action 的集成必须与节点的 integration 一致", () => {
    const ir = v2Sample();
    ir.integrations.push({ id: "other", name: "其他", purpose: "x", access: "api" });
    ir.nodes.find((n) => n.id === "n1")!.integration = "other";
    expect(errorsOf(ir, ERP_OPS)).toMatch(/必须与节点的 integration 一致/);
  });

  it("提供 resolveOperation 时：操作不存在报错", () => {
    expect(errorsOf(v2Sample(), { resolveOperation: () => undefined })).toMatch(/没有操作 listOrders/);
  });

  it("提供 resolveOperation 时：缺少必填参数、多余参数都报错", () => {
    const ir = v2Sample();
    ir.nodes.find((n) => n.id === "n1")!.action = {
      kind: "integration",
      integration: "erp",
      operation: "listOrders",
      params: { start: "{{input.week}}", extra: "x" },
    };
    const msg = errorsOf(ir, ERP_OPS);
    expect(msg).toMatch(/缺少必填参数 end/);
    expect(msg).toMatch(/没有参数 extra/);
  });

  it("不提供 resolveOperation 时不检查操作参数", () => {
    expect(validateWorkflow(v2Sample()).ok).toBe(true);
  });

  it("保留字不能作为节点 id", () => {
    const ir = v2Sample();
    ir.nodes.find((n) => n.id === "n5")!.id = "input";
    expect(errorsOf(ir, ERP_OPS)).toMatch(/保留字/);
  });

  it("节点 id 和变量名不能包含空白或花括号", () => {
    const ir = v2Sample();
    ir.inputs[0]!.name = "bad name";
    expect(validateWorkflow(ir).ok).toBe(false);
  });

  it("condition 中的引用同样会被检查", () => {
    const ir = v2Sample();
    ir.edges.find((e) => e.from === "n3" && e.to === "n4")!.condition = { left: "n9.x", op: "not_empty" };
    expect(errorsOf(ir, ERP_OPS)).toMatch(/引用的节点或元素不存在：n9/);
  });

  it("不支持的 version 直接报错", () => {
    expect(validateWorkflow({ ...v2Sample(), version: 3 }).ok).toBe(false);
  });
});
