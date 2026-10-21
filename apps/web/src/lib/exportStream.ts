import { ApiError, AUTH_EXPIRED_CODE, isSessionExpired, redirectToLogin } from "./api";
import { parseSseChunk } from "./sse";
import { tr } from "../i18n";

/**
 * POST 一个返回 SSE 的导出接口：progress 事件交给回调，返回 result 事件的数据。
 * HTTP 错误和 error 事件都抛出；登录会话失效时跳转登录页。
 */
export async function postSse<R>(
  url: string,
  body: unknown,
  onProgress: (data: unknown) => void,
  failedMessage: string,
  signal?: AbortSignal,
): Promise<R> {
  const res = await fetch(url, {
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

  let result: R | undefined;
  let failure: string | undefined;
  const handle = (e: { event: string; data: unknown }) => {
    if (e.event === "progress") onProgress(e.data);
    else if (e.event === "result") result = e.data as R;
    else if (e.event === "error") failure = (e.data as { message?: string }).message || failedMessage;
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
  if (!result) throw new Error(failedMessage);
  return result;
}
