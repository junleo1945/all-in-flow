import { tr } from "../i18n";

export interface Me {
  UserName: string;
  DisplayName: string;
  is_super_admin: boolean;
  usage: { tokensToday: number; dailyTokenQuota: number; costUsdToday: number };
  features: { sharePublicEnabled: boolean; visionEnabled: boolean };
}

export type Frequency = "daily" | "weekly" | "monthly" | "ad_hoc";

export interface Task {
  id: string;
  title: string;
  frequency: Frequency;
  minutesPerRun?: number;
  /** 用户选的耗时档位；unknown 表示问过但说不准 */
  durationBucket?: "quick" | "half_hour" | "hours" | "half_day" | "day" | "unknown";
  steps: string[];
  systems: string[];
}

export interface PainPoint {
  id: string;
  taskId?: string;
  title: string;
  detail: string;
  severity: number;
  automatable: number;
  evidence?: string;
  score: number | null;
  /** 为 true 表示耗时待确认，分数是按默认耗时估算的 */
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

export type NoteKind = "confirmed" | "declined" | "pending";

export interface Note {
  kind: NoteKind;
  text: string;
}

export interface Profile {
  role: { role?: string; team?: string; systems: string[]; summary?: string };
  tasks: Task[];
  painPoints: PainPoint[];
  candidates: Candidate[];
  notes?: Note[];
  /** 用户要求直接出结果后为 true */
  fastTrack?: boolean;
}

const STAGE_KEYS = ["role", "focus", "dig", "propose", "generate"] as const;

/** 访谈阶段列表（标签按当前语言取，不能在模块顶层缓存） */
export function stageLabels(): Array<{ key: string; label: string }> {
  return STAGE_KEYS.map((key) => ({ key, label: tr(`stage.${key}`) }));
}

export function stageKeys(): readonly string[] {
  return STAGE_KEYS;
}

export function stageLabel(key: string): string | undefined {
  return (STAGE_KEYS as readonly string[]).includes(key) ? tr(`stage.${key}`) : undefined;
}

export function freqLabel(f: Frequency): string {
  return tr(`freq.${f}`);
}

/** 表格里的耗时：选了档位显示档位，说不准显示「说不准」，直接说的分钟数显示分钟，都没有显示「—」 */
export function durationLabel(t: Pick<Task, "minutesPerRun" | "durationBucket">): string {
  if (t.durationBucket === "unknown") return tr("profile.dur.unknown");
  if (t.durationBucket) return tr(`profile.dur.${t.durationBucket}`);
  return t.minutesPerRun !== undefined ? `${t.minutesPerRun} min` : "—";
}

/** 按优先级排序，未评分的排在最后 */
export function rankPainPoints(points: PainPoint[]): PainPoint[] {
  return [...points].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}
