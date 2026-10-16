import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import { SESSION_MAX_AGE_SECONDS } from "../auth/service.js";
import { ErpAuthError, ErpUpstreamError } from "../auth/erp.js";
import type { FixedWindowLimiter } from "../auth/limiter.js";
import { AppError, ok } from "../http/envelope.js";
import { SID_COOKIE, type AppVariables } from "../http/context.js";
import { requireUser } from "../http/middleware.js";
import type { Db } from "../db/client.js";
import { todayUsage } from "../agent/quota.js";
import { tm, tr } from "../i18n.js";

const LoginBody = z.object({
  UserName: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  Password: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
});

export interface UserRouteOptions {
  auth: AuthService;
  loginLimiter: FixedWindowLimiter;
  cookieSecure: boolean;
  cookieDomain?: string;
  db: Db;
  dailyTokenQuotaPerUser: number;
  sharePublicEnabled: boolean;
  visionEnabled: boolean;
}

export function userRoutes(opts: UserRouteOptions) {
  const r = new Hono<{ Variables: AppVariables }>();

  r.post("/login", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = LoginBody.safeParse(raw);
    const username = parsed.success ? (parsed.data.UserName ?? parsed.data.username) : undefined;
    const password = parsed.success ? (parsed.data.Password ?? parsed.data.password) : undefined;
    if (!username || !password) throw new AppError(400, tm(c.get("locale"), "auth.loginRequired"));

    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "direct";
    if (!opts.loginLimiter.hit(`ip:${ip}`) || !opts.loginLimiter.hit(`user:${username.toLowerCase()}`)) {
      throw new AppError(429, tm(c.get("locale"), "auth.tooMany"));
    }

    try {
      const { sid, maxAgeSeconds, user } = await opts.auth.login(username, password);
      setCookie(c, SID_COOKIE, sid, {
        httpOnly: true,
        secure: opts.cookieSecure,
        sameSite: "Lax",
        path: "/",
        domain: opts.cookieDomain,
        maxAge: Math.min(maxAgeSeconds, SESSION_MAX_AGE_SECONDS),
      });
      return ok(c, { UserName: user.username, DisplayName: user.displayName, is_super_admin: user.isAdmin });
    } catch (e) {
      if (e instanceof ErpAuthError) throw new AppError(401, e.message ? tr(c.get("locale"), e.message) : tm(c.get("locale"), "auth.badCredentials"));
      if (e instanceof ErpUpstreamError) throw new AppError(502, tm(c.get("locale"), "auth.erpDown", { msg: e.message }));
      throw e;
    }
  });

  r.use("/info", requireUser(opts.auth));
  r.get("/info", async (c) => {
    const u = c.get("user");
    const usage = await todayUsage(opts.db, u.id);
    return ok(c, {
      UserName: u.username,
      DisplayName: u.displayName,
      is_super_admin: u.isAdmin,
      usage: { tokensToday: usage.tokens, dailyTokenQuota: opts.dailyTokenQuotaPerUser, costUsdToday: usage.costUsd },
      features: { sharePublicEnabled: opts.sharePublicEnabled, visionEnabled: opts.visionEnabled },
    });
  });

  r.post("/logout", async (c) => {
    const sid = getCookie(c, SID_COOKIE);
    if (sid) await opts.auth.destroy(sid);
    deleteCookie(c, SID_COOKIE, { path: "/", domain: opts.cookieDomain });
    return ok(c, null);
  });

  return r;
}
