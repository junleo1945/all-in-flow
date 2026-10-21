import { describe, expect, it } from "vitest";
import { colorizeSkeletons, colorFor, EXECUTOR_COLORS, NEUTRAL_COLORS } from "../lib/colorize";
import { centerScroll } from "../lib/viewport";
import type { WorkflowIR } from "@aif/workflow-ir";

const ir: WorkflowIR = {
  version: 2,
  kind: "automation",
  slug: "demo",
  name: "演示",
  description: "演示",
  trigger: { type: "manual", detail: "手动" },
  inputs: [],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    { id: "a", type: "step", title: "拉取数据", executor: "deterministic", instructions: "x" },
    { id: "b", type: "step", title: "人工确认", executor: "human", instructions: "x" },
    { id: "c", type: "step", title: "写结论", executor: "llm", instructions: "x" },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [],
  source: { painPointIds: [] },
};

describe("画布上色", () => {
  it("按执行方式给节点着色：蓝 / 橙 / 紫", () => {
    expect(colorFor(ir.nodes[1]!)).toEqual(EXECUTOR_COLORS.deterministic);
    expect(colorFor(ir.nodes[2]!)).toEqual(EXECUTOR_COLORS.human);
    expect(colorFor(ir.nodes[3]!)).toEqual(EXECUTOR_COLORS.llm);
  });

  it("只给形状上色，文字和连线保持原样", () => {
    const els = [
      { type: "rectangle", label: { text: "拉取数据" } },
      { type: "text", text: "拉取数据" },
      { type: "arrow" },
      { type: "ellipse", label: { text: "开始" } },
    ];
    const out = colorizeSkeletons(els, ir);
    expect(out[0]).toMatchObject(EXECUTOR_COLORS.deterministic);
    expect(out[1]).toEqual(els[1]);
    expect(out[2]).toEqual(els[2]);
    expect(out[3]).toMatchObject(NEUTRAL_COLORS); // 开始/结束节点使用中性色
  });
});

describe("画布缩略图的视口换算", () => {
  it("点击缩略图后，被点击的场景坐标位于视口中心", () => {
    const v = { scrollX: -120, scrollY: -40, zoom: 0.5, width: 1000, height: 600 };
    const { scrollX, scrollY } = centerScroll(800, 300, v);
    // Excalidraw 的换算：视口中心对应的场景坐标 = 视口宽度 / 2 / zoom - scrollX
    expect(v.width / 2 / v.zoom - scrollX).toBeCloseTo(800);
    expect(v.height / 2 / v.zoom - scrollY).toBeCloseTo(300);
  });
});
