import { fauxProvider } from "@earendil-works/pi-ai";
import { createRuntime } from "../src/agent/models.js";
import { createErpClient } from "../src/auth/erp.js";
import { createAuthService } from "../src/auth/service.js";
import { FixedWindowLimiter } from "../src/auth/limiter.js";
import { createApp } from "../src/app.js";
import { createSessionRegistry } from "../src/agent/registry.js";
import { createDb } from "../src/db/client.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { salesReport } from "./fixtures.js";

/** 假 ERP：用户 zhangsan（管理员）与 lisi（普通用户），密码都是 secret */
export function fakeErp(users: Record<string, number>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    if (u.endsWith("/api/login")) {
      const b = JSON.parse(String(init?.body));
      if (!(b.UserName in users) || b.Password !== "secret") return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ Success: true }), {
        status: 200,
        headers: { "Set-Cookie": `tm_sso_sid=erp-${b.UserName}; Path=/` },
      });
    }
    if (u.endsWith("/user/api/get")) {
      const cookie = new Headers(init?.headers).get("Cookie") ?? "";
      const name = Object.keys(users).find((n) => cookie.includes(`erp-${n}`));
      if (!name) return new Response("", { status: 401 });
      return Response.json({ Success: true, Data: { UserId: users[name], UserName: name, FullName: name, ExpireDuration: 3600 } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

export async function setupTestApp(url: string, overrides: Partial<AppConfig> = {}) {
  const { db, sql } = createDb(url);
  const faux = fauxProvider();
  const runtime = await createRuntime({});
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey(faux.provider.id, "k");

  const config: AppConfig = {
    ...loadConfig({ DATABASE_URL: url }),
    adminUsernames: ["zhangsan"],
    dailyTokenQuotaPerUser: 2_000_000,
    dailyCostLimitUsd: 1000,
    maxTurnsPerConversation: 80,
    sharePublicEnabled: false,
    publicBaseUrl: "http://test.local",
    ...overrides,
  };
  const auth = createAuthService({
    db,
    erp: createErpClient({ baseUrl: "https://erp.test", appCode: "t", fetch: fakeErp({ zhangsan: 990201, lisi: 990202 }) }),
    adminUsernames: config.adminUsernames,
    verifyIntervalSeconds: 300,
  });
  const registry = createSessionRegistry({ db, runtime, agentModel: faux.getModel(), generateIr: async () => ({ ir: salesReport, warnings: [] }) });
  const app = createApp({
    db,
    auth,
    registry,
    config,
    loginLimiter: new FixedWindowLimiter(1000, 60_000),
    cookieSecure: false,
  });

  const login = async (name: string) => {
    const res = await app.request("/api/user/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ UserName: name, Password: "secret" }),
    });
    return res.headers.get("set-cookie")!.split(";")[0]!;
  };

  const api = (cookie: string | undefined, path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...((init.headers as Record<string, string>) ?? {}) },
    });

  return { app, db, sql, faux, registry, config, login, api };
}
