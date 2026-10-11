import { randomUUID } from "node:crypto";

export type Frequency = "daily" | "weekly" | "monthly" | "ad_hoc";

/** 每周大约发生几次，用于打分（ad_hoc 按每月一次的 1/4 估算） */
export const FREQ_PER_WEEK: Record<Frequency, number> = {
  daily: 5,
  weekly: 1,
  monthly: 0.25,
  ad_hoc: 0.1,
};

export interface RoleInfo {
  role?: string;
  team?: string;
  systems: string[];
  summary?: string;
}

export interface Task {
  id: string;
  title: string;
  frequency: Frequency;
  minutesPerRun?: number;
  steps: string[];
  systems: string[];
}

export interface PainPoint {
  id: string;
  taskId?: string;
  title: string;
  detail: string;
  severity: number; // 痛苦程度 1-5
  automatable: number; // 可自动化程度 1-5
  evidence?: string;
  /** 频率 × 单次耗时 × 痛苦程度 × 可自动化程度，未知耗时时为 null */
  score: number | null;
}

export interface Candidate {
  id: string;
  title: string;
  painPointIds: string[];
  summary: string;
  savedMinutesPerWeek?: number;
  systems: string[];
}

export interface Profile {
  role: RoleInfo;
  tasks: Task[];
  painPoints: PainPoint[];
  candidates: Candidate[];
}

export const emptyProfile = (): Profile => ({
  role: { systems: [] },
  tasks: [],
  painPoints: [],
  candidates: [],
});

export function scorePainPoint(p: Pick<PainPoint, "severity" | "automatable">, task?: Task): number | null {
  if (!task || task.minutesPerRun === undefined) return null;
  const perWeek = FREQ_PER_WEEK[task.frequency];
  return Math.round(perWeek * task.minutesPerRun * p.severity * p.automatable * 10) / 10;
}

/** 按优先级从高到低排序，未评分的排在最后 */
export function rankPainPoints(points: PainPoint[]): PainPoint[] {
  return [...points].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

export function upsertTask(profile: Profile, input: Omit<Task, "id" | "steps" | "systems"> & { id?: string; steps?: string[]; systems?: string[] }): Task {
  const id = input.id ?? randomUUID();
  const prev = profile.tasks.find((t) => t.id === id);
  const task: Task = {
    id,
    title: input.title,
    frequency: input.frequency,
    minutesPerRun: input.minutesPerRun ?? prev?.minutesPerRun,
    steps: input.steps ?? prev?.steps ?? [],
    systems: input.systems ?? prev?.systems ?? [],
  };
  profile.tasks = prev ? profile.tasks.map((t) => (t.id === id ? task : t)) : [...profile.tasks, task];
  // 工作的耗时变化后，所有关联痛点的分数都要重算
  for (const p of profile.painPoints) {
    if (p.taskId === id) p.score = scorePainPoint(p, task);
  }
  return task;
}

export function upsertPainPoint(
  profile: Profile,
  input: Omit<PainPoint, "id" | "score"> & { id?: string },
): PainPoint {
  const id = input.id ?? randomUUID();
  const task = profile.tasks.find((t) => t.id === input.taskId);
  const point: PainPoint = { ...input, id, score: scorePainPoint(input, task) };
  profile.painPoints = profile.painPoints.some((p) => p.id === id)
    ? profile.painPoints.map((p) => (p.id === id ? point : p))
    : [...profile.painPoints, point];
  return point;
}
