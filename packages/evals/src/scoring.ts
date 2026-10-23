import type { Persona } from "./personas.js";

/** 一次模拟访谈的产出（运行器从数据库和事件中收集） */
export interface EvalRun {
  personaId: string;
  /** 访谈结束时的画像 */
  painPoints: Array<{ title: string; detail: string; score: number | null; /** 耗时待确认，分数是按默认耗时估算的 */ assumed?: boolean }>;
  /** 访谈最终聚焦的痛点；没有选定时为 undefined */
  focusPainPoint?: { title: string; detail: string };
  /** 画像中记录的工作项数量 */
  taskCount: number;
  /** 进行了几轮用户发言 */
  turns: number;
  /** 访谈 Agent 有几条回复在问单次耗时（含给耗时档位选项） */
  timeQuestions?: number;
  /** 第几轮首次生成工作流；没有生成则为 undefined */
  firstWorkflowTurn?: number;
  /** 第几轮首次提出方案；没有则为 undefined */
  firstProposeTurn?: number;
  /** 提出方案时已记录的痛点数量（用于判断是否过早下结论） */
  painPointsAtFirstPropose?: number;
  /** 用户要求直接出结果（快速模式）。此时提前出方案是用户的选择，不算过早下结论 */
  fastTrack?: boolean;
  /** 生成的每个工作流是否通过 IR 校验 */
  workflowValidity: boolean[];
  /** 生成的每个工作流的 action 覆盖率（有 action 的 step 占比，没有 step 的不记录） */
  actionCoverage?: number[];
  /**
   * 生成的每个工作流的数据整理情况（n8n-guided-export-revision.md 2）：
   * 整理步骤如果只是一句描述，导出时无法变成可执行节点，应该在生成工作流时就写成 code 步骤。
   */
  executability?: Array<{ transformSteps: number; descriptiveTransforms: number; unsafeCode: number }>;
}

export interface RunMetrics {
  personaId: string;
  /** 聚焦命中：最终聚焦的痛点是人设里真实存在的隐藏痛点之一 */
  focusHit: boolean;
  /** 命中的隐藏痛点 id；没有命中时为 null */
  focusedId: string | null;
  /** 一次访谈只该记录一件工作：多记录的工作件数，说明访谈发散了 */
  extraTasks: number;
  /** 量化完整度：有分数的痛点占比。耗时说不准时按默认耗时估算也算有分数 */
  quantified: number;
  /** 耗时已知：有分数且分数不是按默认耗时估算的痛点占比 */
  timeKnown: number;
  /** 访谈 Agent 有几条回复在问单次耗时；越少越好；没有记录时为 null */
  timeQuestions: number | null;
  /** 效率：生成第一个工作流之前用了几轮；未生成则为 null */
  turnsToWorkflow: number | null;
  /** IR 合法率；未生成工作流则为 null */
  irValidRate: number | null;
  /** 还没挖出痛点就提出方案 */
  prematureConclusion: boolean;
  /** action 覆盖率的平均值；没有生成工作流则为 null */
  actionCoverage: number | null;
  /** 描述式整理占比：写成一句描述的 transform 步骤 ÷ 全部 transform 步骤；越低越好；没有 transform 步骤时为 null */
  descriptiveTransformRate: number | null;
  /** 不安全的 code 步骤数量（访问文件、子进程、环境变量等） */
  unsafeCodeSteps: number;
}

function containsAny(text: string, keywords: string[]): boolean {
  const t = text.toLowerCase();
  return keywords.some((k) => t.includes(k.toLowerCase()));
}

export function scoreRun(persona: Persona, run: EvalRun): RunMetrics {
  const focus = run.focusPainPoint;
  const focusedId = focus
    ? (persona.hiddenPainPoints.find((hp) => containsAny(`${focus.title} ${focus.detail}`, hp.keywords))?.id ?? null)
    : null;

  const quantified = run.painPoints.length === 0 ? 0 : run.painPoints.filter((p) => p.score !== null).length / run.painPoints.length;
  const timeKnown = run.painPoints.length === 0 ? 0 : run.painPoints.filter((p) => p.score !== null && !p.assumed).length / run.painPoints.length;

  const irValidRate =
    run.workflowValidity.length === 0 ? null : run.workflowValidity.filter(Boolean).length / run.workflowValidity.length;

  const prematureConclusion =
    !run.fastTrack && run.firstProposeTurn !== undefined && (run.painPointsAtFirstPropose ?? 0) === 0;

  const coverage = run.actionCoverage ?? [];
  const actionCoverage = coverage.length === 0 ? null : avg(coverage)!;

  const exe = run.executability ?? [];
  const transforms = exe.reduce((n, e) => n + e.transformSteps, 0);
  const descriptiveTransformRate = transforms === 0 ? null : exe.reduce((n, e) => n + e.descriptiveTransforms, 0) / transforms;
  const unsafeCodeSteps = exe.reduce((n, e) => n + e.unsafeCode, 0);

  return {
    personaId: persona.id,
    focusHit: focusedId !== null,
    focusedId,
    extraTasks: Math.max(0, run.taskCount - 1),
    quantified,
    timeKnown,
    timeQuestions: run.timeQuestions ?? null,
    turnsToWorkflow: run.firstWorkflowTurn ?? null,
    irValidRate,
    prematureConclusion,
    actionCoverage,
    descriptiveTransformRate,
    unsafeCodeSteps,
  };
}

export interface Summary {
  runs: number;
  /** 聚焦命中的人设占比 */
  focusRate: number;
  /** 平均多记录了几件工作 */
  extraTasks: number;
  quantified: number;
  timeKnown: number;
  /** 每次访谈平均有几条回复在问耗时 */
  timeQuestions: number | null;
  turnsToWorkflow: number | null;
  irValidRate: number | null;
  prematureRate: number;
  workflowRate: number;
  actionCoverage: number | null;
  descriptiveTransformRate: number | null;
  unsafeCodeSteps: number;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** 汇总多个人设的结果；平均值只统计有值的样本 */
export function summarize(metrics: RunMetrics[]): Summary {
  const turns = metrics.map((m) => m.turnsToWorkflow).filter((x): x is number => x !== null);
  const valid = metrics.map((m) => m.irValidRate).filter((x): x is number => x !== null);
  return {
    runs: metrics.length,
    focusRate: metrics.length ? metrics.filter((m) => m.focusHit).length / metrics.length : 0,
    extraTasks: avg(metrics.map((m) => m.extraTasks)) ?? 0,
    quantified: avg(metrics.map((m) => m.quantified)) ?? 0,
    timeKnown: avg(metrics.map((m) => m.timeKnown)) ?? 0,
    timeQuestions: avg(metrics.map((m) => m.timeQuestions).filter((x): x is number => x !== null)),
    turnsToWorkflow: avg(turns),
    irValidRate: avg(valid),
    prematureRate: metrics.length ? metrics.filter((m) => m.prematureConclusion).length / metrics.length : 0,
    workflowRate: metrics.length ? turns.length / metrics.length : 0,
    actionCoverage: avg(metrics.map((m) => m.actionCoverage).filter((x): x is number => x !== null)),
    descriptiveTransformRate: avg(metrics.map((m) => m.descriptiveTransformRate).filter((x): x is number => x !== null)),
    unsafeCodeSteps: metrics.reduce((n, m) => n + m.unsafeCodeSteps, 0),
  };
}

/** 与基线对比：返回每个指标的变化量（正数为增加） */
export function compare(current: Summary, baseline: Summary) {
  // 旧的基线文件里没有新增的指标（值为 undefined），按没有对比处理
  const delta = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? null : a - b);
  return {
    focusRate: delta(current.focusRate, baseline.focusRate),
    extraTasks: delta(current.extraTasks, baseline.extraTasks),
    quantified: delta(current.quantified, baseline.quantified),
    timeKnown: delta(current.timeKnown, baseline.timeKnown),
    timeQuestions: delta(current.timeQuestions, baseline.timeQuestions),
    turnsToWorkflow: delta(current.turnsToWorkflow, baseline.turnsToWorkflow),
    irValidRate: delta(current.irValidRate, baseline.irValidRate),
    prematureRate: current.prematureRate - baseline.prematureRate,
    workflowRate: current.workflowRate - baseline.workflowRate,
    actionCoverage: delta(current.actionCoverage, baseline.actionCoverage),
    descriptiveTransformRate: delta(current.descriptiveTransformRate, baseline.descriptiveTransformRate),
    unsafeCodeSteps: current.unsafeCodeSteps - baseline.unsafeCodeSteps,
  };
}

export function toMarkdown(metrics: RunMetrics[], summary: Summary): string {
  const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
  const num = (x: number | null) => (x === null ? "—" : x.toFixed(1));
  const lines = [
    "| 人设 | 聚焦命中 | 多记的工作 | 量化完整度 | 耗时已知 | 追问耗时 | 生成前轮数 | IR 合法率 | action 覆盖率 | 描述式整理 | 过早下结论 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...metrics.map(
      (m) => `| ${m.personaId} | ${m.focusedId ?? "未命中"} | ${m.extraTasks} | ${pct(m.quantified)} | ${pct(m.timeKnown)} | ${m.timeQuestions ?? "—"} | ${m.turnsToWorkflow ?? "未生成"} | ${pct(m.irValidRate)} | ${pct(m.actionCoverage)} | ${pct(m.descriptiveTransformRate)} | ${m.prematureConclusion ? "是" : "否"} |`,
    ),
    `| **平均** | **${pct(summary.focusRate)}** | **${num(summary.extraTasks)}** | **${pct(summary.quantified)}** | **${pct(summary.timeKnown)}** | **${num(summary.timeQuestions)}** | **${num(summary.turnsToWorkflow)}** | **${pct(summary.irValidRate)}** | **${pct(summary.actionCoverage)}** | **${pct(summary.descriptiveTransformRate)}** | **${pct(summary.prematureRate)}** |`,
  ];
  return lines.join("\n");
}

/** 问耗时的回复：出现"多久、多少分钟、几个小时、耗时"等字眼，或者给出了耗时档位选项 */
const TIME_QUESTION = /多久|多少分钟|几分钟|多长时间|几个小时|多少个?小时|花了.{0,8}时间|耗时|用时|半小时|一两个小时|十几分钟|半天左右|一天以上/;

/** 统计顾问回复里有几条在问单次耗时 */
export function countTimeQuestions(assistantReplies: string[]): number {
  return assistantReplies.filter((r) => TIME_QUESTION.test(r)).length;
}
