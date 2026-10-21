import { describe, expect, it } from "vitest";
import { lower, type WorkflowIR } from "../src/index.js";
import { v2Sample } from "./fixtures-v2.js";

const base = (nodes: WorkflowIR["nodes"], edges: WorkflowIR["edges"]): WorkflowIR => ({
  version: 2,
  kind: "automation",
  slug: "t",
  name: "t",
  description: "t",
  trigger: { type: "manual", detail: "手动" },
  inputs: [],
  nodes,
  edges,
  source: { painPointIds: [] },
});

describe("lower：遍历顺序与回边", () => {
  it("从 start 出发按先序排列，start 在最前", () => {
    const g = lower(v2Sample());
    expect(g.root.order[0]).toBe("s");
    expect(g.root.order.slice(0, 3)).toEqual(["s", "n1", "n2"]);
    expect(new Set(g.root.order).size).toBe(g.root.nodes.length);
  });

  it("循环的回边被识别出来", () => {
    const ir = base(
      [
        { id: "s", type: "start", title: "开始" },
        { id: "a", type: "step", title: "A", executor: "llm", instructions: "a" },
        { id: "d", type: "decision", title: "D", mode: "llm", question: "是否结束" },
        { id: "b", type: "step", title: "B", executor: "llm", instructions: "b" },
        { id: "e", type: "end", title: "结束" },
      ],
      [
        { from: "s", to: "a" },
        { from: "a", to: "d" },
        { from: "d", to: "b", label: "否" },
        { from: "d", to: "e", label: "是" },
        { from: "b", to: "a" },
      ],
    );
    const g = lower(ir);
    expect(g.root.backEdges).toEqual([{ from: "b", to: "a" }]);
    expect(g.features.get("cycle")).toEqual(["b"]);
  });
});

describe("lower：引用解析", () => {
  it("区分工作流输入、节点输出、子流程元素", () => {
    const g = lower(v2Sample());
    expect(g.root.refs.get("n1")).toEqual([{ raw: "input.week", kind: "input", name: "week", path: [] }]);
    expect(g.root.refs.get("n5")).toEqual([
      { raw: "n2.results", kind: "node", nodeId: "n2", name: "results", path: [] },
    ]);
    expect(g.root.refs.get("n3")).toEqual([
      { raw: "n2.results", kind: "node", nodeId: "n2", name: "results", path: [] },
    ]);
    const body = g.root.children.get("n2")!;
    expect(body.refs.get("b1")).toEqual([{ raw: "order.id", kind: "item", name: "order", path: ["id"] }]);
  });

  it("无法解析的引用直接抛错（输入应已通过校验）", () => {
    const ir = v2Sample();
    ir.nodes.find((n) => n.id === "n5")!.action = { kind: "llm", prompt: "{{ghost.x}}" } as any;
    expect(() => lower(ir)).toThrow(/无法解析引用：ghost\.x/);
  });
});

describe("lower：子流程、布局与名称", () => {
  it("foreach 的子流程单独降级", () => {
    const g = lower(v2Sample());
    const body = g.root.children.get("n2")!;
    expect(body.owner).toBe("n2");
    expect(body.order).toEqual(["bs", "b1", "be"]);
  });

  it("布局：沿边的方向向右，层内按遍历顺序向下", () => {
    const g = lower(v2Sample());
    const x = (id: string) => g.root.layout.get(id)!.x;
    expect(x("n1")).toBeLessThan(x("n2"));
    expect(x("n2")).toBeLessThan(x("n3"));
    expect(x("n3")).toBeLessThan(x("n5"));
  });

  it("同名节点的显示名加序号，保证全局唯一", () => {
    const ir = base(
      [
        { id: "s", type: "start", title: "开始" },
        { id: "a", type: "step", title: "处理", executor: "llm", instructions: "a" },
        { id: "b", type: "step", title: "处理", executor: "llm", instructions: "b" },
        { id: "e", type: "end", title: "结束" },
      ],
      [
        { from: "s", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "e" },
      ],
    );
    const g = lower(ir);
    expect(g.names.get("a")).toBe("处理");
    expect(g.names.get("b")).toBe("处理 (2)");
  });
});

describe("lower：能力收集", () => {
  it("记录工作流用到的能力，以及对应的节点", () => {
    const g = lower(v2Sample());
    expect(g.features.get("trigger:schedule")).toEqual([]);
    expect(g.features.get("action:http")).toEqual(["n1"]);
    expect(g.features.get("action:llm")).toEqual(expect.arrayContaining(["n5"]));
    expect(g.features.get("action:human")).toEqual(["n4"]);
    expect(g.features.get("decision:expr")).toEqual(["n3"]);
    expect(g.features.get("foreach")).toEqual(["n2"]);
    expect(g.features.has("cycle")).toBe(false);
  });

  it("并行：一个非判断节点有多条出边", () => {
    const ir = base(
      [
        { id: "s", type: "start", title: "开始" },
        { id: "a", type: "step", title: "A", executor: "llm", instructions: "a" },
        { id: "b", type: "step", title: "B", executor: "llm", instructions: "b" },
        { id: "m", type: "merge", title: "汇合" },
        { id: "e", type: "end", title: "结束" },
      ],
      [
        { from: "s", to: "a" },
        { from: "s", to: "b" },
        { from: "a", to: "m" },
        { from: "b", to: "m" },
        { from: "m", to: "e" },
      ],
    );
    const g = lower(ir);
    expect(g.features.get("parallel")).toEqual(["s"]);
    expect(g.features.get("merge")).toEqual(["m"]);
  });
});
