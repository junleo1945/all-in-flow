import { describe, expect, it } from "vitest";
import { emptyProfile, rankPainPoints, scorePainPoint, upsertPainPoint, upsertTask } from "../src/domain/profile.js";

describe("痛点打分（design.md 5.2）", () => {
  it("优先级 = 频率 × 单次耗时 × 痛苦 × 可自动化", () => {
    const p = emptyProfile();
    const task = upsertTask(p, { title: "周报", frequency: "weekly", minutesPerRun: 210 });
    const point = upsertPainPoint(p, { title: "手工透视", detail: "", severity: 4, automatable: 5, taskId: task.id });
    // 每周 1 次 × 210 分钟 × 4 × 5
    expect(point.score).toBe(4200);
  });

  it("没有耗时数据时分数为 null，并排在最后", () => {
    const p = emptyProfile();
    const withTime = upsertTask(p, { title: "A", frequency: "daily", minutesPerRun: 10 });
    const noTime = upsertTask(p, { title: "B", frequency: "daily" });
    upsertPainPoint(p, { title: "无耗时", detail: "", severity: 5, automatable: 5, taskId: noTime.id });
    upsertPainPoint(p, { title: "有耗时", detail: "", severity: 1, automatable: 1, taskId: withTime.id });
    const ranked = rankPainPoints(p.painPoints);
    expect(ranked.map((x) => x.title)).toEqual(["有耗时", "无耗时"]);
    expect(scorePainPoint({ severity: 3, automatable: 3 }, noTime)).toBeNull();
  });

  it("修改工作耗时后，关联痛点分数自动重算", () => {
    const p = emptyProfile();
    const task = upsertTask(p, { title: "对账", frequency: "monthly", minutesPerRun: 240 });
    upsertPainPoint(p, { title: "改表", detail: "", severity: 5, automatable: 4, taskId: task.id });
    upsertTask(p, { id: task.id, title: "对账", frequency: "monthly", minutesPerRun: 120 });
    expect(p.painPoints[0]!.score).toBe(0.25 * 120 * 5 * 4);
  });
});
