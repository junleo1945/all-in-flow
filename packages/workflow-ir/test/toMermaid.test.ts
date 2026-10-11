import { describe, expect, it } from "vitest";
import { toMermaid } from "../src/index.js";
import { salesReport } from "./fixtures.js";

describe("toMermaid", () => {
  it("renders flowchart with shapes, labels and executor classes", () => {
    const m = toMermaid(salesReport);
    expect(m.startsWith("flowchart TD")).toBe(true);
    expect(m).toContain('n0(["开始"])');
    expect(m).toContain('n2{"有异常订单？"}');
    expect(m).toContain('n2 -->|"有"| n3');
    expect(m).toContain("class n1 det");
    expect(m).toContain("class n3 hum");
    expect(m).toContain("class n4 llm");
  });

  it("escapes double quotes in labels", () => {
    const ir = structuredClone(salesReport);
    ir.nodes.find((n) => n.id === "n1")!.title = '拉取 "本周" 订单';
    expect(toMermaid(ir)).toContain('["拉取 #quot;本周#quot; 订单"]');
  });
});
