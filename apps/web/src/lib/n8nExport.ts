import { ApiError, AUTH_EXPIRED_CODE, isSessionExpired, redirectToLogin } from "./api";
import { parseSseChunk } from "./sse";
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
export async function exportToN8n(
  workflowId: string,
  body: { authorizationId: string; version?: number },
  onProgress: (stage: ExportStage) => void,
  signal?: AbortSignal,
): Promise<N8nExportResult> {
  const res = await fetch(`/api/workflows/${workflowId}/n8n-export`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => null);
    if (isSessionExpired(res.status, err)) {
      redirectToLogin();
      throw new ApiError(AUTH_EXPIRED_CODE, err?.message || tr("common.relogin"), res.status);
    }
    throw new ApiError(err?.code ?? res.status, err?.message || tr("common.requestFailedHttp", { status: res.status }), res.status);
  }

  let result: N8nExportResult | undefined;
  let failure: string | undefined;
  const handle = (e: { event: string; data: unknown }) => {
    if (e.event === "progress") onProgress((e.data as { stage: ExportStage }).stage);
    else if (e.event === "result") result = e.data as N8nExportResult;
    else if (e.event === "error") failure = (e.data as { message?: string }).message || tr("n8nExport.failed");
  };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseChunk(buffer);
    buffer = parsed.rest;
    parsed.events.forEach(handle);
  }
  parseSseChunk(buffer + "\n\n").events.forEach(handle);
  if (failure) throw new Error(failure);
  if (!result) throw new Error(tr("n8nExport.failed"));
  return result;
}
