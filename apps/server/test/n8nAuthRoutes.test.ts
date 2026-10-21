import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { WorkflowIR } from "@aif/workflow-ir";
import { createDb, type Db } from "../src/db/client.js";
import { authorizations, conversations, usageDaily, users, workflows, workflowVersions } from "../src/db/schema/index.js";
import { authorizationRoutes, MAX_AUTHORIZATIONS } from "../src/routes/authorizations.js";
import { n8nExportRoutes } from "../src/routes/n8nExport.js";
import { FixedWindowLimiter } from "../src/auth/limiter.js";
import { AppError, fail } from "../src/http/envelope.js";
import type { AppVariables } from "../src/http/context.js";
import type { N8nExporter } from "../src/n8n/exportAgent.js";

const url = process.env.DATABASE_URL;
const OWNER = 990051;
const OTHER = 990052;
const PLACEHOLDER = "mcp-token-must-never-leak";
const KEY = Buffer.alloc(32, 9);
const publicDns = { lookup: async () => [{ address: "93.184.216.34" }] };

const ir: WorkflowIR = {
  version: 2,
  kind: "automation",
  slug: "weekly",
  name: "周报",
  description: "汇总周报。当用户需要写周报时使用。",
  trigger: { type: "manual", detail: "手动" },
  inputs: [],
  nodes: [
    { id: "s", type: "start", title: "开始" },
    { id: "n1", type: "step", title: "拉取订单", executor: "deterministic", instructions: "拉取订单" },
    { id: "e", type: "end", title: "结束" },
  ],
  edges: [
    { from: "s", to: "n1" },
    { from: "n1", to: "e" },
  ],
  source: { painPointIds: [] },
} as WorkflowIR;

/** 假的 n8n MCP 服务 */
function fakeMcp(opts: { tools?: string[]; reject?: boolean } = {}) {
  const calls: Array<{ method: string; url: string }> = [];
  const tools = opts.tools ?? ["search_nodes", "get_node_types", "list_credentials", "validate_node_config"];
  const fetchFn = (async (u: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(String(init?.body));
    calls.push({ method: body.method, url: String(u) });
    if (opts.reject) return new Response("{}", { status: 401 });
    const rpc = (result: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json", ...extra } });
    if (body.method === "initialize") return rpc({ protocolVersion: "2025-03-26" }, { "mcp-session-id": "s1" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return rpc({ tools: tools.map((name) => ({ name })) });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe.skipIf(!url)("授权管理与 n8n 导出路由（真实数据库 + 假 MCP）", () => {
  let db: Db;
  let close: () => Promise<void>;
  let wfId: string;
  let convId: string;

  beforeAll(async () => {
    const c = createDb(url);
    db = c.db;
    close = () => c.sql.end();
    await db.insert(users).values([{ id: OWNER, username: "n8n-auth", displayName: "授权测试" }, { id: OTHER, username: "n8n-auth-2", displayName: "另一个人" }]).onConflictDoNothing();
    const [conv] = await db.insert(conversations).values({ userId: OWNER }).returning();
    convId = conv!.id;
    const [wf] = await db.insert(workflows).values({ conversationId: convId, userId: OWNER, name: "周报", latestVersion: 1 }).returning();
    wfId = wf!.id;
    await db.insert(workflowVersions).values({ workflowId: wfId, version: 1, ir });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(authorizations).where(inArray(authorizations.userId, [OWNER, OTHER]));
    await db.delete(usageDaily).where(inArray(usageDaily.userId, [OWNER, OTHER]));
    await db.delete(workflowVersions).where(eq(workflowVersions.workflowId, wfId));
    await db.delete(workflows).where(eq(workflows.id, wfId));
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(users).where(inArray(users.id, [OWNER, OTHER]));
    await close();
  });

  function buildApp(userId: number, mcp: ReturnType<typeof fakeMcp>, over: { secretKey?: Buffer | null; exporter?: N8nExporter; exportLimit?: number } = {}) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("locale", "zh");
      c.set("user", { id: userId } as AppVariables["user"]);
      await next();
    });
    const secretKey = over.secretKey === null ? undefined : (over.secretKey ?? KEY);
    const deps = { fetch: mcp.fetchFn, lookup: publicDns.lookup };
    app.route("/api/authorizations", authorizationRoutes({ db: db!, secretKey, limiter: new FixedWindowLimiter(100, 60_000), mcp: deps }));
    app.route(
      "/api/workflows",
      n8nExportRoutes({
        db: db!,
        config: { dailyTokenQuotaPerUser: 2_000_000, dailyCostLimitUsd: 1000, authSecretKey: secretKey },
        exporter: over.exporter,
        limiter: new FixedWindowLimiter(over.exportLimit ?? 100, 60_000),
        mcp: deps,
      }),
    );
    app.onError((err, c) => {
      if (err instanceof AppError) return fail(c, err.status, err.message, err.code);
      throw err;
    });
    return app;
  }
  const json = (res: Response) => res.json() as Promise<{ code: number; data: any; message: string }>;
  const send = (app: Hono<any>, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const create = (app: Hono<any>, over: Record<string, unknown> = {}) =>
    send(app, "POST", "/api/authorizations", { kind: "mcp", name: "我的 n8n", url: "https://n8n.example.com/mcp-server/http", secret: PLACEHOLDER, ...over });

  describe("授权管理", () => {
    it("添加前先连一次 n8n：成功后保存，密文入库，响应和列表里都没有 token", async () => {
      const mcp = fakeMcp();
      const app = buildApp(OWNER, mcp);
      const res = await json(await create(app));
      expect(res.code).toBe(0);
      expect(res.data).toMatchObject({ kind: "mcp", name: "我的 n8n", url: "https://n8n.example.com/mcp-server/http" });
      expect(JSON.stringify(res)).not.toContain(PLACEHOLDER);
      expect(mcp.calls[0]!.url).toBe("https://n8n.example.com/mcp-server/http");

      const [row] = await db.select().from(authorizations).where(eq(authorizations.id, res.data.id));
      expect(row!.secret).not.toContain(PLACEHOLDER);
      const list = await json(await send(app, "GET", "/api/authorizations"));
      expect(list.data.enabled).toBe(true);
      expect(list.data.items).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain(PLACEHOLDER);
    });

    it("连不上、token 被拒绝、内网地址，都不保存", async () => {
      const before = (await db.select().from(authorizations).where(eq(authorizations.userId, OWNER))).length;
      const app = (mcp: ReturnType<typeof fakeMcp>) => buildApp(OWNER, mcp);
      expect((await create(app(fakeMcp({ reject: true })))).status).toBe(401);
      const privateMcp = fakeMcp();
      expect((await create(app(privateMcp), { url: "https://192.168.1.10/mcp-server/http" })).status).toBe(400);
      expect(privateMcp.calls).toHaveLength(0);
      expect((await create(app(privateMcp), { url: "http://n8n.example.com/mcp-server/http" })).status).toBe(400);
      expect((await create(app(fakeMcp()), { name: "" })).status).toBe(400);
      expect((await db.select().from(authorizations).where(eq(authorizations.userId, OWNER))).length).toBe(before);
    });

    it("改名、删除；别人看不到也动不了", async () => {
      const app = buildApp(OWNER, fakeMcp());
      const created = await json(await create(app, { name: "待改名" }));
      const id = created.data.id;
      const other = buildApp(OTHER, fakeMcp());
      expect((await json(await send(other, "GET", "/api/authorizations"))).data.items).toEqual([]);
      expect((await send(other, "PATCH", `/api/authorizations/${id}`, { name: "x" })).status).toBe(404);
      expect((await send(other, "DELETE", `/api/authorizations/${id}`)).status).toBe(404);

      const renamed = await json(await send(app, "PATCH", `/api/authorizations/${id}`, { name: "新名字" }));
      expect(renamed.data.name).toBe("新名字");
      expect((await send(app, "DELETE", `/api/authorizations/${id}`)).status).toBe(200);
      expect((await send(app, "DELETE", `/api/authorizations/${id}`)).status).toBe(404);
    });

    it("没有配置 AUTH_SECRET_KEY 时功能关闭；每人最多保存 10 个", async () => {
      const off = buildApp(OWNER, fakeMcp(), { secretKey: null });
      expect((await json(await send(off, "GET", "/api/authorizations"))).data.enabled).toBe(false);
      expect((await create(off)).status).toBe(503);

      const app = buildApp(OTHER, fakeMcp());
      for (let i = 0; i < MAX_AUTHORIZATIONS; i++) expect((await create(app, { name: `n${i}` })).status).toBe(200);
      const over = await create(app, { name: "多了" });
      expect(over.status).toBe(400);
      expect((await json(over)).message).toContain("最多");
    });
  });

  describe("导出 n8n 工作流（SSE）", () => {
    const events = async (res: Response) => {
      const text = await res.text();
      return text
        .split("\n\n")
        .filter(Boolean)
        .map((block) => {
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          return { event, data: data ? JSON.parse(data) : undefined };
        });
    };
    const okResult = {
      workflow: { name: "周报", nodes: [], connections: {}, settings: { executionOrder: "v1" as const } },
      summary: "一句话",
      excluded: [],
      todo: [],
      problems: [],
    };
    const exporter: N8nExporter = async ({ onProgress, onUsage }) => {
      onProgress?.("analyze");
      onProgress?.("match");
      onProgress?.("validate");
      await onUsage?.({ input: 1000, output: 500, cacheRead: 0, costUsd: 0.01 });
      return okResult;
    };

    it("按选择的授权连接 n8n，推送进度和结果；用量记入配额；响应里没有 token 和用量明细", async () => {
      const app = buildApp(OWNER, fakeMcp(), { exporter });
      const auth = await json(await create(app, { name: "导出用" }));
      const res = await send(app, "POST", `/api/workflows/${wfId}/n8n-export`, { authorizationId: auth.data.id });
      expect(res.status).toBe(200);
      const evs = await events(res);
      expect(evs.map((e) => e.event)).toEqual(["progress", "progress", "progress", "result"]);
      expect(evs.at(-1)!.data).toMatchObject({ version: 1, summary: "一句话" });
      expect(JSON.stringify(evs)).not.toContain(PLACEHOLDER);
      expect(evs.at(-1)!.data.usage).toBeUndefined();
      const [usage] = await db.select().from(usageDaily).where(eq(usageDaily.userId, OWNER));
      expect(usage!.inputTokens).toBe(1000);
    });

    it("导出过程出错时推送 error 事件：地址不可达这类给出原因，其他错误不泄漏内容", async () => {
      const app = buildApp(OWNER, fakeMcp(), { exporter: async () => { throw new Error(`内部错误含 ${PLACEHOLDER}`); } });
      const auth = await json(await create(app, { name: "出错用" }));
      const evs = await events(await send(app, "POST", `/api/workflows/${wfId}/n8n-export`, { authorizationId: auth.data.id }));
      expect(evs.at(-1)).toEqual({ event: "error", data: { message: "导出失败，请稍后重试" } });
      expect(JSON.stringify(evs)).not.toContain(PLACEHOLDER);
    });

    it("不能用别人的授权；授权 id 不存在、没有选择授权、版本无效、没有启用都有明确的错误", async () => {
      const app = buildApp(OWNER, fakeMcp(), { exporter });
      const mine = await json(await create(app, { name: "我的" }));
      const other = buildApp(OTHER, fakeMcp(), { exporter });
      expect((await send(other, "POST", `/api/workflows/${wfId}/n8n-export`, { authorizationId: mine.data.id })).status).toBe(404); // 别人的工作流
      expect((await send(app, "POST", `/api/workflows/${wfId}/n8n-export`, { authorizationId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
      expect((await send(app, "POST", `/api/workflows/${wfId}/n8n-export`, {})).status).toBe(400);
      expect((await send(app, "POST", `/api/workflows/${wfId}/n8n-export`, { authorizationId: mine.data.id, version: 9 })).status).toBe(400);
      expect((await send(buildApp(OWNER, fakeMcp()), "POST", `/api/workflows/${wfId}/n8n-export`, { authorizationId: mine.data.id })).status).toBe(503);
    });

    it("选的 MCP 不是 n8n 的（没有查询节点的工具）时推送明确的错误，不调用导出", async () => {
      let called = false;
      const app = buildApp(OWNER, fakeMcp({ tools: ["some_other_tool"] }), { exporter: async () => { called = true; return okResult; } });
      const auth = await json(await create(app, { name: "别的 MCP" }));
      const evs = await events(await send(app, "POST", `/api/workflows/${wfId}/n8n-export`, { authorizationId: auth.data.id }));
      expect(evs.at(-1)!.event).toBe("error");
      expect(evs.at(-1)!.data.message).toContain("不是 n8n 的");
      expect(called).toBe(false);
    });

    it("按分钟限流", async () => {
      const app = buildApp(OWNER, fakeMcp(), { exporter, exportLimit: 1 });
      const auth = await json(await create(app, { name: "限流用" }));
      const body = { authorizationId: auth.data.id };
      const first = await send(app, "POST", `/api/workflows/${wfId}/n8n-export`, body);
      expect(first.status).toBe(200);
      await first.text(); // 读完流，用量写入后再结束测试
      expect((await send(app, "POST", `/api/workflows/${wfId}/n8n-export`, body)).status).toBe(429);
    });
  });
});
