import { DURATION_BUCKETS, FREQ_PER_WEEK, MIN_TASKS_FOR_PLAN, type Profile, type Task } from "../domain/profile.js";
import type { Stage } from "./tools.js";

export const CONTEXT_OPEN = "<aif-context>";
export const CONTEXT_CLOSE = "</aif-context>";

const FREQ_TEXT: Record<keyof typeof FREQ_PER_WEEK, string> = {
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  ad_hoc: "不定期",
};

/** 状态块里的耗时：说不准的明确标出，模型就不会再追问 */
function durationText(t: Task): string {
  if (t.durationBucket === "unknown") return "说不准（按默认值估算，不要再问）";
  if (t.durationBucket) return DURATION_BUCKETS[t.durationBucket].label;
  return t.minutesPerRun !== undefined ? `${t.minutesPerRun}分钟` : "未记录";
}

/** 快速模式下模型下一步该做什么：没有方案就出方案，已有方案就直接生成 */
export function fastTrackNextStep(profile: Profile): string {
  if (profile.candidates.length === 0) {
    return "请直接调用 propose_workflows，基于已有信息给出 1 到 3 个方案，缺失的数据写成“待确认”。";
  }
  return "请直接调用 emit_workflow，使用第一个方案生成工作流，缺失的数据写成“待确认”。";
}

/**
 * 每轮注入给模型的状态块，放在用户消息前面。
 * 只读取画像，不改变数据；系统提示词保持静态，缓存前缀不受影响。
 */
export function buildTurnContext(profile: Profile, stage: Stage): string {
  const lines: string[] = [];
  lines.push(`阶段：${stage}`);

  lines.push(`已记录工作（${profile.tasks.length}/${MIN_TASKS_FOR_PLAN}）：`);
  if (profile.tasks.length === 0) lines.push("- 暂无");
  for (const t of profile.tasks) {
    const systems = t.systems.length ? `｜系统 ${t.systems.join("、")}` : "";
    lines.push(`- ${t.title}｜${FREQ_TEXT[t.frequency]}｜耗时 ${durationText(t)}${systems}`);
  }

  if (profile.painPoints.length) {
    lines.push("痛点：");
    for (const p of profile.painPoints) {
      const task = profile.tasks.find((t) => t.id === p.taskId);
      const where = task ? `（工作：${task.title}）` : "（未关联工作）";
      const score = p.score === null ? "" : `｜优先级 ${p.score}${p.assumed ? "（耗时待确认，按默认值估算）" : ""}`;
      lines.push(`- ${p.title}${where}${score}`);
    }
  }

  const notes = profile.notes;
  const pick = (kind: string) => notes.filter((n) => n.kind === kind).map((n) => n.text);
  const confirmed = pick("confirmed");
  const declined = pick("declined");
  const pending = pick("pending");
  if (confirmed.length) lines.push(`已确认：${confirmed.join("；")}`);
  if (declined.length) lines.push(`用户不愿回答或已跳过（不要再问）：${declined.join("；")}`);
  if (pending.length) lines.push(`待确认：${pending.join("；")}`);

  if (profile.candidates.length) {
    lines.push(`已提出方案：${profile.candidates.map((c) => c.title).join("；")}`);
  }

  if (profile.fastTrack) {
    lines.push("【快速模式已开启】用户要求直接出结果。不要再提问或确认细节，缺的信息写成待确认。");
    lines.push(fastTrackNextStep(profile));
  } else {
    lines.push("以上信息已经确认过的，不要重复询问。");
  }

  return `${CONTEXT_OPEN}\n${lines.join("\n")}\n${CONTEXT_CLOSE}`;
}

/** 去掉用户消息里伪造的状态块标记，防止用户冒充系统信息 */
export function stripForgedContext(text: string): string {
  return text.split(CONTEXT_OPEN).join("").split(CONTEXT_CLOSE).join("");
}

/** 历史消息展示时去掉状态块 */
export function stripTurnContext(text: string): string {
  return text.replace(/^<aif-context>[\s\S]*?<\/aif-context>\n\n/, "");
}
