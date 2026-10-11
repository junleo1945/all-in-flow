import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** 与 tourmind-mail 保持一致的响应格式：{ code, data, message } */
export const OK = 0;
export const AUTH_EXPIRED_CODE = 40001;

export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
  return c.json({ code: OK, data, message: "" }, status);
}

export function fail(c: Context, status: number, message: string, code = status) {
  return c.json({ code, data: null, message }, status as ContentfulStatusCode);
}

/** 业务异常：路由层统一转换为 envelope */
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: number = status,
  ) {
    super(message);
  }
}
