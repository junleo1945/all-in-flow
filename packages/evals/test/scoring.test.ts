import { describe, expect, it } from "vitest";
import { PERSONAS } from "../src/personas.js";
import { compare, countTimeQuestions, scoreRun, summarize, toMarkdown, type EvalRun } from "../src/scoring.js";

const sales = PERSONAS.find((p) => p.id === "sales-ops")!;

const perfect: EvalRun = {
  personaId: "sales-ops",
  painPoints: [{ title: "手工导出并透视订单", detail: "每周都要做透视", score: 4200 }],
  focusPainPoint: { title: "手工导出并透视订单", detail: "每周都要做透视" },
  taskCount: 1,
  turns: 9,
  firstWorkflowTurn: 9,
  firstProposeTurn: 8,
  painPointsAtFirstPropose: 1,
  workflowValidity: [true],
};

describe("聚焦命中", () => {
  it("聚焦的痛点命中人设里的某个隐藏痛点", () => {
    const m = scoreRun(sales, perfect);
    expect(m.focusHit).toBe(true);
    expect(m.focusedId).toBe("sa1");
  });

  it("没有选定聚焦痛点时不算命中", () => {
    const m = scoreRun(sales, { ...perfect, focusPainPoint: undefined });
    expect(m.focusHit).toBe(false);
    expect(m.focusedId).toBeNull();
  });

  it("关键词匹配不区分大小写", () => {
    const custom = {
      id: "x", role: "x", background: "", style: "",
      hiddenPainPoints: [{ id: "h", description: "", keywords: ["Excel"], frequency: "daily" as const, minutesPerRun: 1 }],
    };
    const m = scoreRun(custom, { ...perfect, personaId: "x", focusPainPoint: { title: "在 excel 里透视", detail: "" } });
    expect(m.focusedId).toBe("h");
  });

  it("无关的痛点不会被误判为命中", () => {
    const m = scoreRun(PERSONAS.find((p) => p.id === "developer")!, {
      ...perfect,
      personaId: "developer",
      focusPainPoint: { title: "报销单据要逐张核对", detail: "" },
    });
    expect(m.focusedId).not.toBe("dev1");
  });

  it("多记录的工作件数说明访谈发散了", () => {
    expect(scoreRun(sales, perfect).extraTasks).toBe(0);
    expect(scoreRun(sales, { ...perfect, taskCount: 3 }).extraTasks).toBe(2);
    expect(scoreRun(sales, { ...perfect, taskCount: 0 }).extraTasks).toBe(0);
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
  it("还没挖出痛点就提出方案记为过早；挖出一个就够", () => {
    expect(scoreRun(sales, { ...perfect, painPointsAtFirstPropose: 0 }).prematureConclusion).toBe(true);
    expect(scoreRun(sales, { ...perfect, painPointsAtFirstPropose: 1 }).prematureConclusion).toBe(false);
  });

  it("从未提出方案时不算过早", () => {
    expect(scoreRun(sales, { ...perfect, firstProposeTurn: undefined, painPointsAtFirstPropose: 0 }).prematureConclusion).toBe(false);
    // 用户要求直接出结果（快速模式）时，提前出方案不算过早下结论
    expect(scoreRun(sales, { ...perfect, painPointsAtFirstPropose: 0, fastTrack: true }).prematureConclusion).toBe(false);
  });
});

describe("汇总与对比", () => {
  it("平均值只统计有值的样本，生成率反映有多少人设走到了工作流", () => {
    const a = scoreRun(sales, perfect);
    const b = scoreRun(sales, { ...perfect, firstWorkflowTurn: undefined, workflowValidity: [] });
    const s = summarize([a, b]);
    expect(s.turnsToWorkflow).toBe(9);
    expect(s.workflowRate).toBe(0.5);
    expect(s.focusRate).toBe(1);
  });

  it("与基线对比得到变化量", () => {
    const cur = summarize([scoreRun(sales, perfect)]);
    const base = summarize([scoreRun(sales, { ...perfect, focusPainPoint: undefined, taskCount: 3 })]);
    const d = compare(cur, base);
    expect(d.focusRate).toBeCloseTo(1);
    expect(d.extraTasks).toBeCloseTo(-2);
  });

  it("markdown 表格包含每个人设与平均行", () => {
    const m = [scoreRun(sales, perfect)];
    const md = toMarkdown(m, summarize(m));
    expect(md).toContain("| sales-ops |");
    expect(md).toContain("**平均**");
  });
});

describe("人设数据", () => {
  it("10 个基础人设，每个都有 3 个隐藏痛点且 id 唯一；另有 3 个「说不清耗时」的变体", () => {
    const base = PERSONAS.filter((p) => !p.cannotEstimate);
    expect(base).toHaveLength(10);
    expect(PERSONAS).toHaveLength(13);
    const ids = base.flatMap((p) => p.hiddenPainPoints.map((h) => h.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PERSONAS) expect(p.hiddenPainPoints).toHaveLength(3);
    expect(new Set(PERSONAS.map((p) => p.id)).size).toBe(PERSONAS.length);
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

describe("数据整理的可执行性", () => {
  it("描述式整理占比：写成一句描述的 transform ÷ 全部 transform，跨工作流合计", () => {
    const m = scoreRun(sales, {
      ...perfect,
      executability: [
        { transformSteps: 2, descriptiveTransforms: 1, unsafeCode: 0 },
        { transformSteps: 2, descriptiveTransforms: 0, unsafeCode: 1 },
      ],
    });
    expect(m.descriptiveTransformRate).toBe(0.25);
    expect(m.unsafeCodeSteps).toBe(1);
  });

  it("没有 transform 步骤时为 null，汇总时不计入；不安全代码数量累加", () => {
    expect(scoreRun(sales, perfect).descriptiveTransformRate).toBeNull();
    const a = scoreRun(sales, { ...perfect, executability: [{ transformSteps: 1, descriptiveTransforms: 1, unsafeCode: 1 }] });
    const b = scoreRun(sales, { ...perfect, executability: [{ transformSteps: 0, descriptiveTransforms: 0, unsafeCode: 2 }] });
    const s = summarize([a, b, scoreRun(sales, perfect)]);
    expect(s.descriptiveTransformRate).toBe(1);
    expect(s.unsafeCodeSteps).toBe(3);
    expect(compare(s, summarize([scoreRun(sales, perfect)])).unsafeCodeSteps).toBe(3);
  });

  it("报告里有描述式整理一列", () => {
    const m = [scoreRun(sales, { ...perfect, executability: [{ transformSteps: 4, descriptiveTransforms: 1, unsafeCode: 0 }] })];
    expect(toMarkdown(m, summarize(m))).toContain("描述式整理");
  });
});

describe("耗时相关指标", () => {
  it("耗时已知 = 有分数且不是按默认耗时估算的；量化完整度把估算的分数也算上", () => {
    const m = scoreRun(sales, {
      ...perfect,
      painPoints: [
        { title: "a", detail: "", score: 100 },
        { title: "b", detail: "", score: 50, assumed: true },
        { title: "c", detail: "", score: null },
        { title: "d", detail: "", score: 10 },
      ],
    });
    expect(m.quantified).toBe(0.75);
    expect(m.timeKnown).toBe(0.5);
  });

  it("统计顾问有几条回复在问耗时：问时长的字眼，或给出耗时档位选项", () => {
    expect(
      countTimeQuestions([
        "每周一次，记下了。这件事一次大概要多久？",
        "你们用什么系统？",
        "单次大概多久：十几分钟以内、半小时左右、一两个小时、半天左右、一天以上、说不准？",
        "上一次花了多少时间？",
        "那这个痛点有多严重？",
      ]),
    ).toBe(3);
  });

  it("汇总取每次访谈的平均追问次数；没有记录的不参与平均", () => {
    const base = scoreRun(sales, { ...perfect, timeQuestions: 4 });
    const other = scoreRun(sales, { ...perfect, timeQuestions: 2 });
    const none = scoreRun(sales, perfect);
    expect(none.timeQuestions).toBeNull();
    expect(summarize([base, other, none]).timeQuestions).toBe(3);
    expect(summarize([none]).timeQuestions).toBeNull();
  });

  it("和没有这些指标的旧基线对比时，新指标的变化量为 null，不会算出 NaN", () => {
    const current = summarize([scoreRun(sales, { ...perfect, timeQuestions: 3 })]);
    const oldBaseline = { ...summarize([scoreRun(sales, perfect)]) } as any;
    delete oldBaseline.timeKnown;
    delete oldBaseline.timeQuestions;
    const diff = compare(current, oldBaseline);
    expect(diff.timeKnown).toBeNull();
    expect(diff.timeQuestions).toBeNull();
    expect(diff.focusRate).toBe(0);
  });

  it("报告里有耗时已知和追问耗时两列", () => {
    const m = scoreRun(sales, { ...perfect, timeQuestions: 5 });
    const md = toMarkdown([m], summarize([m]));
    expect(md).toContain("耗时已知");
    expect(md).toContain("追问耗时");
    expect(md).toMatch(/\| sales-ops \| sa1 \| 0 \| 100% \| 100% \| 5 \|/);
  });

  it("人设里有三个「说不清耗时」的变体，和原人设的痛点一致", () => {
    const vague = PERSONAS.filter((p) => p.cannotEstimate);
    expect(vague.map((p) => p.id)).toEqual(["sales-ops-vague", "finance-accountant-vague", "hr-recruiter-vague"]);
    for (const v of vague) {
      const base = PERSONAS.find((p) => p.id === v.id.replace("-vague", ""))!;
      expect(v.hiddenPainPoints).toEqual(base.hiddenPainPoints);
      expect(base.cannotEstimate).toBeUndefined();
    }
  });
});
