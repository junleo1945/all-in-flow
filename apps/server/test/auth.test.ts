import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createAuthService } from "../src/auth/service.js";
import { createErpClient, type ErpClient } from "../src/auth/erp.js";
import { FixedWindowLimiter } from "../src/auth/limiter.js";
import { createDb } from "../src/db/client.js";
import { createSessionRegistry } from "../src/agent/registry.js";
import { loadConfig } from "../src/config.js";
import { users, authSessions } from "../src/db/schema/index.js";
import { eq } from "drizzle-orm";

const url = process.env.DATABASE_URL;

/** 模拟 ERP：账号 auth-user / 密码 secret 正确，其它一律拒绝（用户名与其它测试文件区分开，避免 users 表唯一约束冲突） */
function fakeErpFetch(opts: { verifyFails?: { value: boolean } } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/login")) {
      const body = JSON.parse(String(init?.body));
      if (body.UserName !== "auth-user" || body.Password !== "secret") {
        return new Response(JSON.stringify({ Success: false, UserMsg: "账号或密码错误" }), { status: 401 });
      }
      return new Response(JSON.stringify({ Success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": "tm_sso_sid=erp-abc; Path=/; HttpOnly" },
      });
    }
    if (url.endsWith("/user/api/get")) {
      const cookie = new Headers(init?.headers).get("Cookie") ?? "";
      if (!cookie.includes("tm_sso_sid=erp-abc") || opts.verifyFails?.value) return new Response("", { status: 401 });
      return Response.json({ Success: true, Data: { UserId: 990101, UserName: "auth-user", FullName: "张三", ExpireDuration: 3600 } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function erpWith(fetchImpl: typeof fetch): ErpClient {
  return createErpClient({ baseUrl: "https://erp.test", appCode: "test", fetch: fetchImpl });
}

describe.skipIf(!url)("ERP 登录（真实数据库 + 模拟 ERP）", () => {
  const { db, sql } = createDb(url);
  const build = (erp: ErpClient, limit = 100) => {
    const auth = createAuthService({ db, erp, adminUsernames: ["auth-user"], verifyIntervalSeconds: 0 });
    // 认证测试不会打开 Agent 会话，所以注册表不需要真实的模型运行时
    const registry = createSessionRegistry({ db, runtime: null as any, agentModel: null as any, generateIr: async () => { throw new Error("unused"); } });
    const app = createApp({
      db,
      auth,
      registry,
      config: { ...loadConfig({ DATABASE_URL: url! }), adminUsernames: ["auth-user"], dailyTokenQuotaPerUser: 1, dailyCostLimitUsd: 1, maxTurnsPerConversation: 1, sharePublicEnabled: false, publicBaseUrl: "http://x" },
      loginLimiter: new FixedWindowLimiter(limit, 60_000),
      cookieSecure: false,
    });
    return { app, auth };
  };
  const post = (app: { request: (...a: any[]) => Promise<Response> }, path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("登录成功：设置 httpOnly 的 aif_sid，不暴露 ERP 的 sid", async () => {
    const { app } = build(erpWith(fakeErpFetch()));
    const res = await post(app, "/api/user/login", { UserName: "auth-user", Password: "secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.UserName).toBe("auth-user");
    expect(body.data.is_super_admin).toBe(true);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/aif_sid=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).not.toMatch(/tm_sso_sid/);
    expect(JSON.stringify(body)).not.toMatch(/erp-abc/);
  });

  it("账号密码错误返回 401，不创建会话", async () => {
    const { app } = build(erpWith(fakeErpFetch()));
    const res = await post(app, "/api/user/login", { UserName: "auth-user", Password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("带 aif_sid 访问 /info 成功，无 cookie 返回 40001", async () => {
    const { app } = build(erpWith(fakeErpFetch()));
    const login = await post(app, "/api/user/login", { UserName: "auth-user", Password: "secret" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const info = await app.request("/api/user/info", { headers: { Cookie: cookie } });
    expect((await info.json()).data.UserName).toBe("auth-user");

    const anon = await app.request("/api/user/info");
    expect((await anon.json()).code).toBe(40001);
  });

  it("ERP 复核失败时踢出本地会话", async () => {
    const flag = { value: false };
    const { app } = build(erpWith(fakeErpFetch({ verifyFails: flag })));
    const login = await post(app, "/api/user/login", { UserName: "auth-user", Password: "secret" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    flag.value = true; // 登录后 ERP 会话失效
    const info = await app.request("/api/user/info", { headers: { Cookie: cookie } });
    expect(info.status).toBe(401);
  });

  it("登录接口限流", async () => {
    const { app } = build(erpWith(fakeErpFetch()), 2);
    await post(app, "/api/user/login", { UserName: "auth-user", Password: "wrong" });
    await post(app, "/api/user/login", { UserName: "auth-user", Password: "wrong" });
    const res = await post(app, "/api/user/login", { UserName: "auth-user", Password: "wrong" });
    expect(res.status).toBe(429);
  });

  it("登出删除服务端会话", async () => {
    const { app } = build(erpWith(fakeErpFetch()));
    const login = await post(app, "/api/user/login", { UserName: "auth-user", Password: "secret" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const sid = cookie.split("=")[1]!;
    await app.request("/api/user/logout", { method: "POST", headers: { Cookie: cookie } });
    const rows = await db.select().from(authSessions).where(eq(authSessions.sid, sid));
    expect(rows.length).toBe(0);
  });

  it("首次登录写入 users 表", async () => {
    const { app } = build(erpWith(fakeErpFetch()));
    await post(app, "/api/user/login", { UserName: "auth-user", Password: "secret" });
    const [u] = await db.select().from(users).where(eq(users.id, 990101));
    expect(u?.displayName).toBe("张三");
  });

  it("afterAll: 清理测试数据并关闭连接", async () => {
    await db.delete(authSessions).where(eq(authSessions.userId, 990101));
    await db.delete(users).where(eq(users.id, 990101));
    await sql.end();
  });
});
