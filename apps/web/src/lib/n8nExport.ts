import { postSse } from "./exportStream";
import { tr } from "../i18n";

export type ExportStage = "analyze" | "match" | "validate";

export interface N8nExportResult {
  version: number;
  workflow: { name: string; nodes: unknown[]; connections: Record<string, unknown>; settings: Record<string, unknown> };
  summary: string;
  excluded: Array<{ title: string; reason: string }>;
  todo: string[];
  problems: string[];
}

/** 可以直接粘贴到 n8n 画布的文本 */
export function workflowText(result: N8nExportResult): string {
  return JSON.stringify(result.workflow, null, 2);
}

/** 导出为 n8n 工作流：逐个回调进度，返回最终结果；失败时抛出 */
export function exportToN8n(
  workflowId: string,
  body: { authorizationId: string; version?: number },
  onProgress: (stage: ExportStage) => void,
  signal?: AbortSignal,
): Promise<N8nExportResult> {
  return postSse<N8nExportResult>(`/api/workflows/${workflowId}/n8n-export`, body, (d) => onProgress((d as { stage: ExportStage }).stage), tr("n8nExport.failed"), signal);
}
