import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRuntime } from "../src/agent/models.js";
import { createErpClient } from "../src/auth/erp.js";
import { createAuthService } from "../src/auth/service.js";
import { FixedWindowLimiter } from "../src/auth/limiter.js";
import { createApp } from "../src/app.js";
import { createSessionRegistry } from "../src/agent/registry.js";
import { createDb, type Db } from "../src/db/client.js";
import { authSessions, conversations, sessionEntries, users, usageDaily, workflows, workflowVersions } from "../src/db/schema/index.js";
import { salesReport } from "./fixtures.js";
import { loadConfig } from "../src/config.js";

const url = process.env.DATABASE_URL;
const ERP_USER_ID = 990003;

/** 模拟 ERP：http-user / secret 登录成功（与 helpers 的 zhangsan 区分开） */
const fakeErp = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = String(input);
  if (u.endsWith("/api/login")) {
    const b = JSON.parse(String(init?.body));
    if (b.UserName !== "http-user" || b.Password !== "secret") return new Response("{}", { status: 401 });
    return new Response(JSON.stringify({ Success: true }), { status: 200, headers: { "Set-Cookie": "tm_sso_sid=erp-x; Path=/" } });
  }
  if (u.endsWith("/user/api/get")) {
    return Response.json({ Success: true, Data: { UserId: ERP_USER_ID, UserName: "http-user", FullName: "张三", ExpireDuration: 3600 } });
  }
  return new Response("", { status: 404 });
}) as typeof fetch;

describe.skipIf(!url)("HTTP 端到端（假 ERP + 假模型 + 真实数据库）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let faux: ReturnType<typeof fauxProvider>;

  beforeAll(async () => {
    const c = createDb(url);
    db = c.db;
    close = () => c.sql.end();
    faux = fauxProvider();
    const runtime = await createRuntime({});
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, "k");

    const config = { ...loadConfig({ DATABASE_URL: url }), dailyTokenQuotaPerUser: 2_000_000, dailyCostLimitUsd: 1000, maxTurnsPerConversation: 80 };
    const auth = createAuthService({ db, erp: createErpClient({ baseUrl: "https://erp.test", appCode: "t", fetch: fakeErp }), adminUsernames: [], verifyIntervalSeconds: 300 });
    const registry = createSessionRegistry({
      db,
      runtime,
      agentModel: faux.getModel(),
      generateIr: async () => ({ ir: salesReport, warnings: [] }),
    });
    app = createApp({ db, auth, registry, config, loginLimiter: new FixedWindowLimiter(100, 60000), cookieSecure: false });

    const login = await app.request("/api/user/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ UserName: "http-user", Password: "secret" }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterAll(async () => {
    if (!db) return;
    const wfs = await db.select({ id: workflows.id }).from(workflows).where(eq(workflows.userId, ERP_USER_ID));
    for (const w of wfs) await db.delete(workflowVersions).where(eq(workflowVersions.workflowId, w.id));
    await db.delete(workflows).where(eq(workflows.userId, ERP_USER_ID));
    const convs = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.userId, ERP_USER_ID));
    for (const c of convs) await db.delete(sessionEntries).where(eq(sessionEntries.conversationId, c.id));
    await db.delete(conversations).where(eq(conversations.userId, ERP_USER_ID));
    await db.delete(usageDaily).where(eq(usageDaily.userId, ERP_USER_ID));
    await db.delete(authSessions).where(eq(authSessions.userId, ERP_USER_ID));
    await db.delete(users).where(eq(users.id, ERP_USER_ID));
    await close();
  });

  const api = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers ?? {}) } });

  let convId: string;

  it("未登录访问会话接口返回 40001", async () => {
    const res = await app.request("/api/conversations");
    expect((await res.json()).code).toBe(40001);
  });

  it("创建会话、列表、详情", async () => {
    const created = await (await api("/api/conversations", { method: "POST" })).json();
    convId = created.data.id;
    expect(convId).toBeTruthy();
    const list = await (await api("/api/conversations")).json();
    expect(list.data.some((c: any) => c.id === convId)).toBe(true);
    const detail = await (await api(`/api/conversations/${convId}`)).json();
    expect(detail.data.profile.tasks).toEqual([]);
  });

  it("发送消息返回 SSE：文本增量、工具事件、done", async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("record_task", { title: "销售周报", frequency: "weekly", minutesPerRun: 210 })], { stopReason: "toolUse" }),
      fauxAssistantMessage("记下了。"),
    ]);
    const res = await api(`/api/conversations/${convId}/messages`, { method: "POST", body: JSON.stringify({ text: "每周做销售周报" }) });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: tool");
    expect(body).toContain("record_task");
    expect(body).toContain("event: text_delta");
    expect(body).toContain("event: done");

    const detail = await (await api(`/api/conversations/${convId}`)).json();
    expect(detail.data.profile.tasks[0].title).toBe("销售周报");
  });

  it("空消息返回 400", async () => {
    const res = await api(`/api/conversations/${convId}/messages`, { method: "POST", body: JSON.stringify({ text: "" }) });
    expect(res.status).toBe(400);
  });

  it("其他用户访问会话返回 404（不泄露是否存在）", async () => {
    const otherId = "00000000-0000-0000-0000-000000000000";
    const res = await api(`/api/conversations/${otherId}`);
    expect(res.status).toBe(404);
  });

  it("删除会话后不可再访问", async () => {
    const created = await (await api("/api/conversations", { method: "POST" })).json();
    const id = created.data.id;
    await api(`/api/conversations/${id}`, { method: "DELETE" });
    const res = await api(`/api/conversations/${id}`);
    expect(res.status).toBe(404);
  });

  it("置顶会话排在列表最前，取消置顶后恢复按更新时间排序", async () => {
    const a = (await (await api("/api/conversations", { method: "POST" })).json()).data.id;
    const b = (await (await api("/api/conversations", { method: "POST" })).json()).data.id;
    const ids = async () => ((await (await api("/api/conversations")).json()).data as Array<{ id: string }>).map((c) => c.id);

    const pinRes = await api(`/api/conversations/${a}`, { method: "PATCH", body: JSON.stringify({ pinned: true }) });
    expect((await pinRes.json()).code).toBe(0);
    expect((await ids())[0]).toBe(a);

    await api(`/api/conversations/${a}`, { method: "PATCH", body: JSON.stringify({ pinned: false }) });
    expect((await ids()).indexOf(b)).toBeLessThan((await ids()).indexOf(a));

    const bad = await api(`/api/conversations/${a}`, { method: "PATCH", body: JSON.stringify({ pinned: "yes" }) });
    expect(bad.status).toBe(400);
  });

  it("修改会话标题，空标题返回 400", async () => {
    const id = (await (await api("/api/conversations", { method: "POST" })).json()).data.id;
    const res = await api(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title: "  销售周报  " }) });
    expect((await res.json()).code).toBe(0);
    const detail = await (await api(`/api/conversations/${id}`)).json();
    expect(detail.data.title).toBe("销售周报");

    const empty = await api(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title: "   " }) });
    expect(empty.status).toBe(400);
  });

  it("工作流版本接口", async () => {
    const [wf] = await db.insert(workflows).values({ conversationId: convId, userId: ERP_USER_ID, name: "测试", latestVersion: 1 }).returning();
    await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, ir: salesReport });
    const list = await (await api(`/api/workflows/${wf!.id}/versions`)).json();
    expect(list.data.latestVersion).toBe(1);
    const v = await (await api(`/api/workflows/${wf!.id}/versions/1`)).json();
    expect(v.data.ir.name).toBe(salesReport.name);
    const missing = await api(`/api/workflows/${wf!.id}/versions/9`);
    expect(missing.status).toBe(404);
  });

  it("保存新版本：校验通过后版本号加一，旧版本不变；不合法的内容被拒绝", async () => {
    const [wf] = await db.insert(workflows).values({ conversationId: convId, userId: ERP_USER_ID, name: "测试", latestVersion: 1 }).returning();
    await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, ir: salesReport });
    const ir = { ...salesReport, nodes: salesReport.nodes.map((n) => (n.type === "step" && n.id === "n4" ? { ...n, template: "三段式周报" } : n)) };
    const saved = await (await api(`/api/workflows/${wf!.id}/versions`, { method: "POST", body: JSON.stringify({ ir }) })).json();
    expect(saved.data.version).toBe(2);
    const v2 = await (await api(`/api/workflows/${wf!.id}/versions/2`)).json();
    expect(JSON.stringify(v2.data.ir)).toContain("三段式周报");
    const v1 = await (await api(`/api/workflows/${wf!.id}/versions/1`)).json();
    expect(JSON.stringify(v1.data.ir)).not.toContain("三段式周报");

    const bad = await api(`/api/workflows/${wf!.id}/versions`, { method: "POST", body: JSON.stringify({ ir: { version: 2, nodes: [] } }) });
    expect(bad.status).toBe(400);
    const none = await api(`/api/workflows/${wf!.id}/versions`, { method: "POST", body: "{}" });
    expect(none.status).toBe(400);
  });
});

describe.skipIf(!url)("历史消息接口", () => {
  it("返回用户与助手的文本消息，不含工具调用", async () => {
    // 复用上面的装配：重新登录并创建会话
    const { setupTestApp } = await import("./helpers.js");
    const env = await setupTestApp(url!);
    const cookie = await env.login("zhangsan");
    const created = await (await env.api(cookie, "/api/conversations", { method: "POST" })).json();
    const id = created.data.id;
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("update_profile", { role: "销售运营" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好的，我是销售运营。"),
    ]);
    await env.api(cookie, `/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text: "我是销售运营" }) }).then((r) => r.text());
    const res = await (await env.api(cookie, `/api/conversations/${id}/messages`)).json();
    expect(res.data.map(({ createdAt: _t, ...m }: { createdAt: string }) => m)).toEqual([
      { role: "user", text: "我是销售运营" },
      { role: "assistant", text: "好的，我是销售运营。" },
    ]);
    // 每条消息都带上有效的时间
    for (const m of res.data as Array<{ createdAt: string }>) {
      expect(Number.isNaN(Date.parse(m.createdAt))).toBe(false);
    }
    // 清理：本测试新建的会话、条目、登录会话和用户
    const schema = await import("../src/db/schema/index.js");
    const { eq } = await import("drizzle-orm");
    await env.db.delete(schema.sessionEntries).where(eq(schema.sessionEntries.conversationId, id));
    await env.db.delete(schema.conversations).where(eq(schema.conversations.id, id));
    await env.db.delete(schema.usageDaily).where(eq(schema.usageDaily.userId, 990201));
    await env.db.delete(schema.authSessions).where(eq(schema.authSessions.userId, 990201));
    await env.db.delete(schema.users).where(eq(schema.users.id, 990201));
    await env.sql.end();
  }, 30000);
});
