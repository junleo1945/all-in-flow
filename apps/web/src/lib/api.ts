import { currentLocale, tr } from "../i18n";

/** 与服务端一致的响应格式：{ code, data, message } */
export interface Envelope<T> {
  code: number;
  data: T;
  message: string;
}

export class ApiError extends Error {
  constructor(
    public code: number,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export const AUTH_EXPIRED_CODE = 40001;

/** 会话失效时跳转登录页，并带上回跳地址 */
export function redirectToLogin() {
  if (typeof window === "undefined") return;
  if (window.location.pathname.startsWith("/login")) return;
  const redirect = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.replace(`/login?redirect=${redirect}`);
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Locale": currentLocale(), ...(init.body ? { "Content-Type": "application/json" } : {}) };
  const res = await fetch(`/api${path}`, { credentials: "include", ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  const body = (await res.json().catch(() => null)) as Envelope<T> | null;

  if (res.status === 401 || body?.code === AUTH_EXPIRED_CODE) {
    // 登录和退出本身不需要跳转：登录失败要留在页面上提示，退出后本来就去登录页
    if (path !== "/user/login" && path !== "/user/logout") redirectToLogin();
    throw new ApiError(AUTH_EXPIRED_CODE, body?.message || tr("common.authFailed"), res.status);
  }
  if (!body || typeof body !== "object" || !("code" in body)) {
    throw new ApiError(-1, tr("common.requestFailedHttp", { status: res.status }), res.status);
  }
  if (body.code !== 0) {
    throw new ApiError(body.code, body.message || tr("common.requestFailed"), res.status);
  }
  return body.data;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) => request<T>(path, { method: "POST", body: data === undefined ? undefined : JSON.stringify(data) }),
  patch: <T>(path: string, data: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(data) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
