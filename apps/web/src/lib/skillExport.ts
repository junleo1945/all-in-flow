import type { ExportIssue } from "@aif/workflow-ir";
import { postSse } from "./exportStream";
import { tr } from "../i18n";

export type SkillStage = "analyze" | "write" | "validate";

export interface SkillExportBody {
  version?: number;
  target?: "generic" | "claude-code" | "pi";
  packaging?: "zip" | "claude-plugin";
  /** 导出前补充、还没有保存为新版本的内容：节点 id → 判断标准或模板 */
  answers?: Record<string, string>;
}

export interface SkillExportResult {
  version: number;
  /** 带 zip 外层目录的文件 */
  files: Array<{ path: string; content: string }>;
  filename: string;
  issues: ExportIssue[];
  warnings: string[];
  todo: string[];
  /** 是否回退到了基础版本（模型不可用或写得不合格） */
  fallback: boolean;
  fallbackReason?: string;
}

/** 让模型撰写 Agent Skill：逐个回调进度，返回最终结果；失败时抛出 */
export function exportSkill(
  workflowId: string,
  body: SkillExportBody,
  onProgress: (stage: SkillStage) => void,
  signal?: AbortSignal,
): Promise<SkillExportResult> {
  return postSse<SkillExportResult>(`/api/workflows/${workflowId}/skill-export`, body, (d) => onProgress((d as { stage: SkillStage }).stage), tr("skillExport.failed"), signal);
}
