import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { AuthService } from "../auth/service.js";
import { ErpUpstreamError } from "../auth/erp.js";
import { AppError } from "./envelope.js";
import { SID_COOKIE, type AppVariables } from "./context.js";
import { tm } from "../i18n.js";

/** 要求已登录；会话失效返回 40001（前端据此跳转登录页）。 */
export function requireUser(auth: AuthService) {
  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const sid = getCookie(c, SID_COOKIE);
    if (!sid) throw new AppError(401, tm(c.get("locale"), "auth.expired"), 40001);
    let user;
    try {
      user = await auth.verify(sid);
    } catch (e) {
      if (e instanceof ErpUpstreamError) throw new AppError(502, tm(c.get("locale"), "auth.ssoDown", { msg: (e as Error).message }));
      throw e;
    }
    if (!user) throw new AppError(401, tm(c.get("locale"), "auth.expired"), 40001);
    c.set("user", user);
    c.set("sid", sid);
    await next();
  });
}
