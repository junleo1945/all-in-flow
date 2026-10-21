import { describe, expect, it } from "vitest";
import { AUTH_EXPIRED_CODE, isSessionExpired } from "../lib/api";

describe("isSessionExpired", () => {
  it("响应码为登录失效时，无论状态码是什么都算失效", () => {
    expect(isSessionExpired(401, { code: AUTH_EXPIRED_CODE })).toBe(true);
    expect(isSessionExpired(200, { code: AUTH_EXPIRED_CODE })).toBe(true);
  });

  it("其他接口返回的 401（例如 n8n 拒绝了 API Key）不算登录失效", () => {
    expect(isSessionExpired(401, { code: 401 })).toBe(false);
    expect(isSessionExpired(403, { code: 403 })).toBe(false);
  });

  it("网关直接返回 401、没有可识别的响应体时，按登录失效处理", () => {
    expect(isSessionExpired(401, null)).toBe(true);
    expect(isSessionExpired(401, {})).toBe(true);
  });

  it("正常响应不算失效", () => {
    expect(isSessionExpired(200, { code: 0 })).toBe(false);
    expect(isSessionExpired(500, null)).toBe(false);
  });
});
