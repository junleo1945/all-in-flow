import { ApiError, AUTH_EXPIRED_CODE, redirectToLogin } from "./api";

export interface SseEvent {
  event: string;
  data: unknown;
}

/** 解析 text/event-stream：事件之间以空行分隔，支持多行 data */
export function parseSseChunk(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf("\n\n")) >= 0) {
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join("\n");
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // 非 JSON 的数据原样返回
    }
    events.push({ event, data });
  }
  return { events, rest };
}

/** 发送一条消息并逐个回调 SSE 事件。失败时抛出 ApiError。 */
export async function sendMessage(
  conversationId: string,
  text: string,
  onEvent: (e: SseEvent) => void,
  signal?: AbortSignal,
  attachmentIds?: string[],
): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(attachmentIds?.length ? { text, attachmentIds } : { text }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    if (res.status === 401 || body?.code === AUTH_EXPIRED_CODE) {
      redirectToLogin();
      throw new ApiError(AUTH_EXPIRED_CODE, body?.message || "请重新登录", res.status);
    }
    throw new ApiError(body?.code ?? res.status, body?.message || `请求失败 (HTTP ${res.status})`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseChunk(buffer);
    buffer = parsed.rest;
    parsed.events.forEach(onEvent);
  }
  const tail = parseSseChunk(buffer + "\n\n");
  tail.events.forEach(onEvent);
}
