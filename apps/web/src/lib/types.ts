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
  role: { role?: string; team?: string; systems: string[]; summary?: string };
  tasks: Task[];
  painPoints: PainPoint[];
  candidates: Candidate[];
}

export const STAGE_LABELS: Array<{ key: string; label: string }> = [
  { key: "role", label: "了解角色" },
  { key: "inventory", label: "盘点工作" },
  { key: "dig", label: "深挖痛点" },
  { key: "rank", label: "量化排序" },
  { key: "propose", label: "提出方案" },
  { key: "generate", label: "生成工作流" },
];

export const FREQ_LABEL: Record<Frequency, string> = {
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  ad_hoc: "不定期",
};

/** 按优先级排序，未评分的排在最后 */
export function rankPainPoints(points: PainPoint[]): PainPoint[] {
  return [...points].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}
