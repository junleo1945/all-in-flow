import type { WorkflowIR } from "@aif/workflow-ir";
import type { Profile } from "../domain/profile.js";

export const MAX_CONTEXT_CHARS = 6000;

const clip = (text: string | undefined, n: number) => (text && text.length > n ? `${text.slice(0, n)}…` : text ?? "");

/**
 * 从访谈画像里摘出和这个工作流相关的部分：用户的角色、解决的痛点（原话和证据）、相关的工作，以及已确认的要点。
 * 用来让模型理解「为什么」，并从用户的说法里提取触发关键词。只取相关部分并限制长度，不带整份画像。
 */
export function buildContext(profile: Profile, ir: WorkflowIR): string {
  const ids = new Set(ir.source.painPointIds);
  const points = profile.painPoints.filter((p) => ids.has(p.id));
  const taskIds = new Set(points.map((p) => p.taskId).filter((x): x is string => !!x));
  const tasks = profile.tasks.filter((t) => taskIds.has(t.id));

  const lines: string[] = [];
  const role = [profile.role.role, profile.role.team].filter(Boolean).join(" / ");
  if (role || profile.role.summary || profile.role.systems.length) {
    lines.push(`用户：${[role, clip(profile.role.summary, 200), profile.role.systems.length ? `常用系统：${profile.role.systems.join("、")}` : ""].filter(Boolean).join("；")}`);
  }
  for (const p of points) {
    lines.push(`痛点「${clip(p.title, 60)}」：${clip(p.detail, 300)}${p.evidence ? `（用户原话：${clip(p.evidence, 200)}）` : ""}`);
  }
  for (const t of tasks) {
    lines.push(`相关的工作「${clip(t.title, 60)}」：频率 ${t.frequency}${t.minutesPerRun ? `，每次约 ${t.minutesPerRun} 分钟` : ""}${t.steps.length ? `；现在的做法：${clip(t.steps.join(" → "), 300)}` : ""}`);
  }
  for (const n of profile.notes.filter((x) => x.kind === "confirmed").slice(-10)) lines.push(`已确认：${clip(n.text, 200)}`);

  const text = lines.join("\n");
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}…` : text;
}
