import { describe, expect, it } from "vitest";
import { PERSONAS } from "../src/personas.js";
import { compare, scoreRun, summarize, toMarkdown, type EvalRun } from "../src/scoring.js";

const sales = PERSONAS.find((p) => p.id === "sales-ops")!;

const perfect: EvalRun = {
  personaId: "sales-ops",
  painPoints: [
    { title: "手工导出并透视订单", detail: "每周都要做透视", score: 4200 },
    { title: "挨个私聊核对异常订单", detail: "催了好几次", score: 3600 },
    { title: "催单消息分散在群里", detail: "经常漏看", score: 1800 },
  ],
  taskCount: 3,
  turns: 9,
  firstWorkflowTurn: 9,
  firstProposeTurn: 8,
  tasksAtFirstPropose: 3,
  workflowValidity: [true],
};

describe("痛点召回", () => {
  it("关键词命中即视为挖出", () => {
    const m = scoreRun(sales, perfect);
    expect(m.recall).toBe(1);
    expect(m.missedIds).toEqual([]);
  });

  it("没挖出的痛点列在 missedIds 中", () => {
    const m = scoreRun(sales, { ...perfect, painPoints: [perfect.painPoints[0]!] });
    expect(m.recall).toBeCloseTo(1 / 3);
    expect(m.missedIds).toEqual(["sa2", "sa3"]);
  });

  it("关键词匹配不区分大小写", () => {
    const custom = {
      id: "x", role: "x", background: "", style: "",
      hiddenPainPoints: [{ id: "h", description: "", keywords: ["Excel"], frequency: "daily" as const, minutesPerRun: 1 }],
    };
    const m = scoreRun(custom, { ...perfect, personaId: "x", painPoints: [{ title: "在 excel 里透视", detail: "", score: null }] });
    expect(m.recalledIds).toEqual(["h"]);
  });

  it("无关的痛点不会被误判为命中", () => {
    const m = scoreRun(PERSONAS.find((p) => p.id === "developer")!, {
      ...perfect,
      personaId: "developer",
      painPoints: [{ title: "报销单据要逐张核对", detail: "", score: null }],
    });
    expect(m.recalledIds).not.toContain("dev1");
  });
});

describe("量化完整度", () => {
  it("有分数的痛点占比", () => {
    const m = scoreRun(sales, { ...perfect, painPoints: [{ title: "a", detail: "", score: 1 }, { title: "b", detail: "", score: null }] });
    expect(m.quantified).toBe(0.5);
  });
});

describe("效率与合法率", () => {
  it("未生成工作流时轮数与合法率为 null", () => {
    const m = scoreRun(sales, { ...perfect, firstWorkflowTurn: undefined, workflowValidity: [] });
    expect(m.turnsToWorkflow).toBeNull();
    expect(m.irValidRate).toBeNull();
  });

  it("合法率 = 通过校验的工作流 ÷ 生成的工作流", () => {
    const m = scoreRun(sales, { ...perfect, workflowValidity: [true, false, true, true] });
    expect(m.irValidRate).toBe(0.75);
  });
});

describe("过早下结论", () => {
  it("工作项少于 3 个就提出方案记为过早", () => {
    expect(scoreRun(sales, { ...perfect, tasksAtFirstPropose: 1 }).prematureConclusion).toBe(true);
    expect(scoreRun(sales, { ...perfect, tasksAtFirstPropose: 3 }).prematureConclusion).toBe(false);
  });

  it("从未提出方案时不算过早", () => {
    expect(scoreRun(sales, { ...perfect, firstProposeTurn: undefined, tasksAtFirstPropose: 0 }).prematureConclusion).toBe(false);
  });
});

describe("汇总与对比", () => {
  it("平均值只统计有值的样本，生成率反映有多少人设走到了工作流", () => {
    const a = scoreRun(sales, perfect);
    const b = scoreRun(sales, { ...perfect, firstWorkflowTurn: undefined, workflowValidity: [] });
    const s = summarize([a, b]);
    expect(s.turnsToWorkflow).toBe(9);
    expect(s.workflowRate).toBe(0.5);
    expect(s.recall).toBe(1);
  });

  it("与基线对比得到变化量", () => {
    const cur = summarize([scoreRun(sales, perfect)]);
    const base = summarize([scoreRun(sales, { ...perfect, painPoints: [] })]);
    const d = compare(cur, base);
    expect(d.recall).toBeCloseTo(1);
  });

  it("markdown 表格包含每个人设与平均行", () => {
    const m = [scoreRun(sales, perfect)];
    const md = toMarkdown(m, summarize(m));
    expect(md).toContain("| sales-ops |");
    expect(md).toContain("**平均**");
  });
});

describe("人设数据", () => {
  it("共 10 个人设，每个都有 3 个隐藏痛点且 id 唯一", () => {
    expect(PERSONAS).toHaveLength(10);
    const ids = PERSONAS.flatMap((p) => p.hiddenPainPoints.map((h) => h.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PERSONAS) expect(p.hiddenPainPoints).toHaveLength(3);
  });
});

describe("action 覆盖率", () => {
  it("取各个工作流覆盖率的平均值", () => {
    const m = scoreRun(sales, { ...perfect, actionCoverage: [0.5, 1] });
    expect(m.actionCoverage).toBe(0.75);
  });

  it("没有生成工作流时为 null，汇总时不计入", () => {
    expect(scoreRun(sales, { ...perfect, firstWorkflowTurn: undefined, workflowValidity: [] }).actionCoverage).toBeNull();
    const s = summarize([
      scoreRun(sales, { ...perfect, actionCoverage: [0.8] }),
      scoreRun(sales, { ...perfect, firstWorkflowTurn: undefined, workflowValidity: [] }),
    ]);
    expect(s.actionCoverage).toBe(0.8);
  });

  it("报告表格包含覆盖率列，对比时给出变化量", () => {
    const m = [scoreRun(sales, { ...perfect, actionCoverage: [0.8] })];
    const md = toMarkdown(m, summarize(m));
    expect(md).toMatch(/action 覆盖率/);
    expect(md).toMatch(/\| sales-ops .*80%/);
    const base = summarize([scoreRun(sales, { ...perfect, actionCoverage: [0.5] })]);
    expect(compare(summarize(m), base).actionCoverage).toBeCloseTo(0.3);
  });
});
