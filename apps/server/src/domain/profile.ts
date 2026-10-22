import { randomUUID } from "node:crypto";

export type Frequency = "daily" | "weekly" | "monthly" | "ad_hoc";

/**
 * 单次耗时的选项：让用户选档，不让他报分钟数（多数人说不准具体分钟）。
 * minutes 是打分时用的代表值。
 */
export const DURATION_BUCKETS = {
  quick: { label: "十几分钟以内", minutes: 10 },
  half_hour: { label: "半小时左右", minutes: 30 },
  hours: { label: "一两个小时", minutes: 90 },
  half_day: { label: "半天左右", minutes: 240 },
  day: { label: "一天以上", minutes: 480 },
} as const;
export type DurationKey = keyof typeof DURATION_BUCKETS;
/** 问过耗时但用户说不准时记为 unknown，之后不再追问 */
export type DurationAnswer = DurationKey | "unknown";
export const DURATION_KEYS = [...(Object.keys(DURATION_BUCKETS) as DurationKey[]), "unknown"] as const;
/** 耗时说不准或没问到时，排序用的保守默认值（分钟） */
export const DEFAULT_MINUTES_PER_RUN = 30;
/** 给用户看的选项文字，含"说不准" */
export const DURATION_OPTIONS_TEXT = [...Object.values(DURATION_BUCKETS).map((b) => b.label), "说不准"].join("、");

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
  /** 单次耗时（分钟）：用户直接说出的，或由 durationBucket 的代表值换算；没有时按默认值估算 */
  minutesPerRun?: number;
  /** 用户选的耗时档位；unknown 表示问过但说不准（不再追问） */
  durationBucket?: DurationAnswer;
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
  /** 频率 × 单次耗时 × 痛苦程度 × 可自动化程度；没有关联到工作项时为 null */
  score: number | null;
  /** 为 true 表示耗时待确认，分数是按默认耗时估算的（界面标为未量化） */
  assumed?: boolean;
}

export interface Candidate {
  id: string;
  title: string;
  painPointIds: string[];
  summary: string;
  savedMinutesPerWeek?: number;
  systems: string[];
}

/** 访谈中确定下来的事实：已确认、用户明确拒绝回答的话题、仍待确认的问题 */
export type NoteKind = "confirmed" | "declined" | "pending";

export interface Note {
  kind: NoteKind;
  text: string;
}

export interface Profile {
  role: RoleInfo;
  tasks: Task[];
  painPoints: PainPoint[];
  candidates: Candidate[];
  notes: Note[];
  /** 用户要求直接出结果后置为 true，之后整个会话不再追问 */
  fastTrack: boolean;
}

/** 记录的工作达到这个数量、痛点也同样多时，信息就比较充分，可以进入方案 */
export const MIN_TASKS_FOR_PLAN = 3;
export const MAX_NOTES = 40;

export const emptyProfile = (): Profile => ({
  role: { systems: [] },
  tasks: [],
  painPoints: [],
  candidates: [],
  notes: [],
  fastTrack: false,
});

/** 读取数据库中的画像时补齐新增字段，兼容旧数据 */
export function normalizeProfile(raw: Partial<Profile> | null | undefined): Profile {
  return { ...emptyProfile(), ...(raw ?? {}) } as Profile;
}

export function progressLine(profile: Profile): string {
  return `进度：已记录工作 ${profile.tasks.length}/${MIN_TASKS_FOR_PLAN}，痛点 ${profile.painPoints.length}，已记录要点 ${profile.notes.length}。`;
}

/**
 * 打分：每周次数 × 单次耗时 × 痛苦程度 × 可自动化程度。
 * 耗时不详时按默认耗时估算并标记 assumed，照样参与排序；没有关联到工作项（不知道频率）时才没有分数。
 */
export function scoreOf(p: Pick<PainPoint, "severity" | "automatable">, task?: Task): { score: number | null; assumed: boolean } {
  if (!task) return { score: null, assumed: false };
  const known = task.minutesPerRun !== undefined;
  const minutes = known ? task.minutesPerRun! : DEFAULT_MINUTES_PER_RUN;
  const perWeek = FREQ_PER_WEEK[task.frequency];
  return { score: Math.round(perWeek * minutes * p.severity * p.automatable * 10) / 10, assumed: !known };
}

export function scorePainPoint(p: Pick<PainPoint, "severity" | "automatable">, task?: Task): number | null {
  return scoreOf(p, task).score;
}

/** 重算并写回分数；assumed 只在为 true 时保留，保持数据干净 */
export function applyScore(p: PainPoint, task?: Task): void {
  const { score, assumed } = scoreOf(p, task);
  p.score = score;
  if (assumed) p.assumed = true;
  else delete p.assumed;
}

/** 按优先级从高到低排序，未评分的排在最后 */
export function rankPainPoints(points: PainPoint[]): PainPoint[] {
  return [...points].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

export function upsertTask(
  profile: Profile,
  input: Omit<Task, "id" | "steps" | "systems" | "minutesPerRun" | "durationBucket"> & {
    id?: string;
    minutesPerRun?: number;
    durationBucket?: DurationAnswer;
    steps?: string[];
    systems?: string[];
  },
): Task {
  const id = input.id ?? randomUUID();
  const prev = profile.tasks.find((t) => t.id === id);
  // 用户直接说出的分钟数优先；只选了档位就用档位的代表值；说不准（unknown）不覆盖已有的数字
  let minutesPerRun = input.minutesPerRun ?? prev?.minutesPerRun;
  if (input.minutesPerRun === undefined && input.durationBucket && input.durationBucket !== "unknown") {
    minutesPerRun = DURATION_BUCKETS[input.durationBucket].minutes;
  }
  const durationBucket = input.durationBucket ?? (input.minutesPerRun !== undefined ? undefined : prev?.durationBucket);
  const task: Task = {
    id,
    title: input.title,
    frequency: input.frequency,
    ...(minutesPerRun !== undefined ? { minutesPerRun } : {}),
    ...(durationBucket ? { durationBucket } : {}),
    steps: input.steps ?? prev?.steps ?? [],
    systems: input.systems ?? prev?.systems ?? [],
  };
  profile.tasks = prev ? profile.tasks.map((t) => (t.id === id ? task : t)) : [...profile.tasks, task];
  // 工作的耗时变化后，所有关联痛点的分数都要重算
  for (const p of profile.painPoints) {
    if (p.taskId === id) applyScore(p, task);
  }
  return task;
}

export function upsertPainPoint(
  profile: Profile,
  input: Omit<PainPoint, "id" | "score" | "assumed"> & { id?: string },
): PainPoint {
  const id = input.id ?? randomUUID();
  const task = profile.tasks.find((t) => t.id === input.taskId);
  const point: PainPoint = { ...input, id, score: null };
  applyScore(point, task);
  profile.painPoints = profile.painPoints.some((p) => p.id === id)
    ? profile.painPoints.map((p) => (p.id === id ? point : p))
    : [...profile.painPoints, point];
  return point;
}
