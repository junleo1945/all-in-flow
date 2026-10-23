import { describe, expect, it } from "vitest";
import { DEFAULT_MINUTES_PER_RUN, DURATION_BUCKETS, emptyProfile, focusOf, normalizeStage, rankPainPoints, scorePainPoint, upsertPainPoint, upsertTask } from "../src/domain/profile.js";

describe("痛点打分（design.md 5.2）", () => {
  it("优先级 = 频率 × 单次耗时 × 痛苦 × 可自动化", () => {
    const p = emptyProfile();
    const task = upsertTask(p, { title: "周报", frequency: "weekly", minutesPerRun: 210 });
    const point = upsertPainPoint(p, { title: "手工透视", detail: "", severity: 4, automatable: 5, taskId: task.id });
    // 每周 1 次 × 210 分钟 × 4 × 5
    expect(point.score).toBe(4200);
  });

  it("耗时说不准也能打分：按默认耗时估算并标记，排序时和有耗时的放在一起比", () => {
    const p = emptyProfile();
    const withTime = upsertTask(p, { title: "A", frequency: "daily", minutesPerRun: 10 });
    const noTime = upsertTask(p, { title: "B", frequency: "daily" });
    const unknown = upsertTask(p, { title: "C", frequency: "daily", durationBucket: "unknown" });
    const a = upsertPainPoint(p, { title: "无耗时", detail: "", severity: 5, automatable: 5, taskId: noTime.id });
    const b = upsertPainPoint(p, { title: "有耗时", detail: "", severity: 1, automatable: 1, taskId: withTime.id });
    const c = upsertPainPoint(p, { title: "说不准", detail: "", severity: 2, automatable: 2, taskId: unknown.id });
    expect(a.score).toBe(5 * DEFAULT_MINUTES_PER_RUN * 5 * 5);
    expect(a.assumed).toBe(true);
    expect(c.assumed).toBe(true);
    expect(b.score).toBe(5 * 10 * 1 * 1);
    expect(b.assumed).toBeUndefined(); // 耗时已知的不带标记
    expect(rankPainPoints(p.painPoints).map((x) => x.title)).toEqual(["无耗时", "说不准", "有耗时"]);
  });

  it("没有关联到工作项（不知道频率）时才没有分数，并排在最后", () => {
    const p = emptyProfile();
    const task = upsertTask(p, { title: "A", frequency: "weekly", minutesPerRun: 10 });
    upsertPainPoint(p, { title: "没关联", detail: "", severity: 5, automatable: 5 });
    upsertPainPoint(p, { title: "关联了", detail: "", severity: 1, automatable: 1, taskId: task.id });
    expect(rankPainPoints(p.painPoints).map((x) => x.title)).toEqual(["关联了", "没关联"]);
    expect(p.painPoints[0]!.score).toBeNull();
    expect(scorePainPoint({ severity: 3, automatable: 3 }, undefined)).toBeNull();
  });

  it("选了耗时档位就用档位的代表值；用户直接说的分钟数优先；说不准不会覆盖已有的数字", () => {
    const p = emptyProfile();
    const t = upsertTask(p, { title: "日报", frequency: "daily", durationBucket: "hours" });
    expect(t.minutesPerRun).toBe(DURATION_BUCKETS.hours.minutes);
    expect(t.durationBucket).toBe("hours");
    // 之后用户直接说了分钟数：以分钟数为准，档位清掉
    const exact = upsertTask(p, { id: t.id, title: "日报", frequency: "daily", minutesPerRun: 75 });
    expect(exact.minutesPerRun).toBe(75);
    expect(exact.durationBucket).toBeUndefined();
    // 只是更新其他字段，耗时保持不变
    const kept = upsertTask(p, { id: t.id, title: "日报（改名）", frequency: "daily" });
    expect(kept.minutesPerRun).toBe(75);
    // 说不准：问过的标记留下，不覆盖已有数字
    const unsure = upsertTask(p, { id: t.id, title: "日报", frequency: "daily", durationBucket: "unknown" });
    expect(unsure.durationBucket).toBe("unknown");
    expect(unsure.minutesPerRun).toBe(75);
  });

  it("耗时从说不准变成已知后，关联痛点的分数重算并去掉未量化标记", () => {
    const p = emptyProfile();
    const task = upsertTask(p, { title: "对账", frequency: "weekly", durationBucket: "unknown" });
    upsertPainPoint(p, { title: "改表", detail: "", severity: 2, automatable: 3, taskId: task.id });
    expect(p.painPoints[0]!.assumed).toBe(true);
    upsertTask(p, { id: task.id, title: "对账", frequency: "weekly", durationBucket: "half_day" });
    expect(p.painPoints[0]!.score).toBe(1 * 240 * 2 * 3);
    expect(p.painPoints[0]!.assumed).toBeUndefined();
  });

  it("修改工作耗时后，关联痛点分数自动重算", () => {
    const p = emptyProfile();
    const task = upsertTask(p, { title: "对账", frequency: "monthly", minutesPerRun: 240 });
    upsertPainPoint(p, { title: "改表", detail: "", severity: 5, automatable: 4, taskId: task.id });
    upsertTask(p, { id: task.id, title: "对账", frequency: "monthly", minutesPerRun: 120 });
    expect(p.painPoints[0]!.score).toBe(0.25 * 120 * 5 * 4);
  });
});

describe("聚焦与阶段", () => {
  it("选定过的优先；没选定时只记了一件、一个的就是聚焦；记了好几件没选定时为空", () => {
    const p = emptyProfile();
    expect(focusOf(p)).toEqual({ task: undefined, painPoint: undefined });
    const a = upsertTask(p, { title: "日报", frequency: "daily" });
    const pain = upsertPainPoint(p, { taskId: a.id, title: "手工抓数", detail: "", severity: 4, automatable: 4 });
    expect(focusOf(p)).toEqual({ task: a, painPoint: pain });
    const b = upsertTask(p, { title: "周报", frequency: "weekly" });
    expect(focusOf(p).task).toBeUndefined();
    p.focusTaskId = b.id;
    // 聚焦的工作下还没有痛点，别的工作的痛点不算
    expect(focusOf(p)).toEqual({ task: b, painPoint: undefined });
    p.focusPainPointId = pain.id;
    expect(focusOf(p).painPoint).toBe(pain);
  });

  it("旧的阶段取值换成现在的阶段，未知的回到 role", () => {
    expect(normalizeStage("inventory")).toBe("focus");
    expect(normalizeStage("rank")).toBe("dig");
    expect(normalizeStage("propose")).toBe("propose");
    expect(normalizeStage("whatever")).toBe("role");
  });
});
