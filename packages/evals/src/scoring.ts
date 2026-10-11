import type { Persona } from "./personas.js";

/** 一次模拟访谈的产出（运行器从数据库和事件中收集） */
export interface EvalRun {
  personaId: string;
  /** 访谈结束时的画像 */
  painPoints: Array<{ title: string; detail: string; score: number | null }>;
  /** 画像中记录的工作项数量 */
  taskCount: number;
  /** 进行了几轮用户发言 */
  turns: number;
  /** 第几轮首次生成工作流；没有生成则为 undefined */
  firstWorkflowTurn?: number;
  /** 第几轮首次提出方案；没有则为 undefined */
  firstProposeTurn?: number;
  /** 提出方案时已记录的工作项数量（用于判断是否过早下结论） */
  tasksAtFirstPropose?: number;
  /** 生成的每个工作流是否通过 IR 校验 */
  workflowValidity: boolean[];
  /** 生成的每个工作流的 action 覆盖率（有 action 的 step 占比，没有 step 的不记录） */
  actionCoverage?: number[];
}

export interface RunMetrics {
  personaId: string;
  /** 痛点召回率：识别出的隐藏痛点 ÷ 人设中的隐藏痛点总数 */
  recall: number;
  recalledIds: string[];
  missedIds: string[];
  /** 量化完整度：有分数（即有频率和耗时）的痛点占比 */
  quantified: number;
  /** 效率：生成第一个工作流之前用了几轮；未生成则为 null */
  turnsToWorkflow: number | null;
  /** IR 合法率；未生成工作流则为 null */
  irValidRate: number | null;
  /** 盘点阶段还没结束就提出方案 */
  prematureConclusion: boolean;
  /** action 覆盖率的平均值；没有生成工作流则为 null */
  actionCoverage: number | null;
}

/** 与设计文档一致：盘点阶段至少记录 3 件工作才算结束 */
export const MIN_TASKS_BEFORE_PROPOSE = 3;

function containsAny(text: string, keywords: string[]): boolean {
  const t = text.toLowerCase();
  return keywords.some((k) => t.includes(k.toLowerCase()));
}

export function scoreRun(persona: Persona, run: EvalRun): RunMetrics {
  const recalledIds: string[] = [];
  const missedIds: string[] = [];
  for (const hp of persona.hiddenPainPoints) {
    const hit = run.painPoints.some((p) => containsAny(`${p.title} ${p.detail}`, hp.keywords));
    (hit ? recalledIds : missedIds).push(hp.id);
  }
  const total = persona.hiddenPainPoints.length;
  const recall = total === 0 ? 0 : recalledIds.length / total;

  const quantified = run.painPoints.length === 0 ? 0 : run.painPoints.filter((p) => p.score !== null).length / run.painPoints.length;

  const irValidRate =
    run.workflowValidity.length === 0 ? null : run.workflowValidity.filter(Boolean).length / run.workflowValidity.length;

  const prematureConclusion =
    run.firstProposeTurn !== undefined && (run.tasksAtFirstPropose ?? 0) < MIN_TASKS_BEFORE_PROPOSE;

  const coverage = run.actionCoverage ?? [];
  const actionCoverage = coverage.length === 0 ? null : avg(coverage)!;

  return {
    personaId: persona.id,
    recall,
    recalledIds,
    missedIds,
    quantified,
    turnsToWorkflow: run.firstWorkflowTurn ?? null,
    irValidRate,
    prematureConclusion,
    actionCoverage,
  };
}

export interface Summary {
  runs: number;
  recall: number;
  quantified: number;
  turnsToWorkflow: number | null;
  irValidRate: number | null;
  prematureRate: number;
  workflowRate: number;
  actionCoverage: number | null;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** 汇总多个人设的结果；平均值只统计有值的样本 */
export function summarize(metrics: RunMetrics[]): Summary {
  const turns = metrics.map((m) => m.turnsToWorkflow).filter((x): x is number => x !== null);
  const valid = metrics.map((m) => m.irValidRate).filter((x): x is number => x !== null);
  return {
    runs: metrics.length,
    recall: avg(metrics.map((m) => m.recall)) ?? 0,
    quantified: avg(metrics.map((m) => m.quantified)) ?? 0,
    turnsToWorkflow: avg(turns),
    irValidRate: avg(valid),
    prematureRate: metrics.length ? metrics.filter((m) => m.prematureConclusion).length / metrics.length : 0,
    workflowRate: metrics.length ? turns.length / metrics.length : 0,
    actionCoverage: avg(metrics.map((m) => m.actionCoverage).filter((x): x is number => x !== null)),
  };
}

/** 与基线对比：返回每个指标的变化量（正数为增加） */
export function compare(current: Summary, baseline: Summary) {
  const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
  return {
    recall: delta(current.recall, baseline.recall),
    quantified: delta(current.quantified, baseline.quantified),
    turnsToWorkflow: delta(current.turnsToWorkflow, baseline.turnsToWorkflow),
    irValidRate: delta(current.irValidRate, baseline.irValidRate),
    prematureRate: current.prematureRate - baseline.prematureRate,
    workflowRate: current.workflowRate - baseline.workflowRate,
    actionCoverage: delta(current.actionCoverage, baseline.actionCoverage),
  };
}

export function toMarkdown(metrics: RunMetrics[], summary: Summary): string {
  const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
  const num = (x: number | null) => (x === null ? "—" : x.toFixed(1));
  const lines = [
    "| 人设 | 痛点召回 | 量化完整度 | 生成前轮数 | IR 合法率 | action 覆盖率 | 过早下结论 |",
    "|---|---|---|---|---|---|---|",
    ...metrics.map(
      (m) => `| ${m.personaId} | ${pct(m.recall)} | ${pct(m.quantified)} | ${m.turnsToWorkflow ?? "未生成"} | ${pct(m.irValidRate)} | ${pct(m.actionCoverage)} | ${m.prematureConclusion ? "是" : "否"} |`,
    ),
    `| **平均** | **${pct(summary.recall)}** | **${pct(summary.quantified)}** | **${num(summary.turnsToWorkflow)}** | **${pct(summary.irValidRate)}** | **${pct(summary.actionCoverage)}** | **${pct(summary.prematureRate)}** |`,
  ];
  return lines.join("\n");
}
