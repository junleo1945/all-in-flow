import { describe, expect, it } from "vitest";
import { actionCoverage, migrateIr, type WorkflowIR } from "../src/index.js";
import { salesReport } from "./fixtures.js";

describe("actionCoverage", () => {
  it("v1 迁移后的样例没有 action", () => {
    expect(actionCoverage(migrateIr(salesReport))).toEqual({ steps: 3, withAction: 0, ratio: 0 });
  });

  it("统计子流程中的 step，只计入带 action 的", () => {
    const ir: WorkflowIR = {
      ...migrateIr(salesReport),
      nodes: [
        { id: "s", type: "start", title: "开始" },
        { id: "a", type: "step", title: "A", executor: "llm", instructions: "a", action: { kind: "llm", prompt: "a" } },
        {
          id: "f",
          type: "foreach",
          title: "循环",
          over: "a.items",
          item: "x",
          body: {
            nodes: [
              { id: "bs", type: "start", title: "开始" },
              { id: "b", type: "step", title: "B", executor: "llm", instructions: "b" },
              { id: "be", type: "end", title: "结束" },
            ],
            edges: [
              { from: "bs", to: "b" },
              { from: "b", to: "be" },
            ],
          },
        },
        { id: "e", type: "end", title: "结束" },
      ],
      edges: [
        { from: "s", to: "a" },
        { from: "a", to: "f" },
        { from: "f", to: "e" },
      ],
    };
    expect(actionCoverage(ir)).toEqual({ steps: 2, withAction: 1, ratio: 0.5 });
  });

  it("没有 step 时 ratio 为 null", () => {
    const ir: WorkflowIR = {
      ...migrateIr(salesReport),
      nodes: [
        { id: "s", type: "start", title: "开始" },
        { id: "e", type: "end", title: "结束" },
      ],
      edges: [{ from: "s", to: "e" }],
    };
    expect(actionCoverage(ir).ratio).toBeNull();
  });
});
