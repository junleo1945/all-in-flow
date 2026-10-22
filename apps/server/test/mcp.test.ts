import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { setupTestApp } from "./helpers.js";
import { accessTokens, authSessions, conversations, sessionEntries, shares, usageDaily, users, workflows, workflowVersions } from "../src/db/schema/index.js";
import { salesReport } from "./fixtures.js";

const url = process.env.DATABASE_URL;
const IDS = [990201, 990202];

describe.skipIf(!url)("访问令牌与 MCP 端点（真实数据库）", () => {
  let env: Awaited<ReturnType<typeof setupTestApp>>;
  let owner: string;
  let other: string;
  let ownerToken: string;
  let otherToken: string;

  const clean = async () => {
    await env.db.delete(accessTokens).where(inArray(accessTokens.userId, IDS));
    await env.db.delete(shares).where(inArray(shares.userId, IDS));
    const wfs = await env.db.select({ id: workflows.id }).from(workflows).where(inArray(workflows.userId, IDS));
    for (const w of wfs) await env.db.delete(workflowVersions).where(eq(workflowVersions.workflowId, w.id));
    await env.db.delete(workflows).where(inArray(workflows.userId, IDS));
    const convs = await env.db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.userId, IDS));
    for (const c of convs) await env.db.delete(sessionEntries).where(eq(sessionEntries.conversationId, c.id));
    await env.db.delete(conversations).where(inArray(conversations.userId, IDS));
    await env.db.delete(usageDaily).where(inArray(usageDaily.userId, IDS));
    await env.db.delete(authSessions).where(inArray(authSessions.userId, IDS));
  };

  beforeAll(async () => {
    env = await setupTestApp(url!);
    await clean();
    await env.db.insert(users).values([
      { id: 990201, username: "zhangsan", displayName: "zhangsan" },
      { id: 990202, username: "lisi", displayName: "lisi" },
    ]).onConflictDoNothing();
    owner = await env.login("zhangsan");
    other = await env.login("lisi");
  });

  afterAll(async () => {
    if (!env) return;
    await clean();
    await env.db.delete(users).where(inArray(users.id, IDS));
    await env.sql.end();
  });

  // —— MCP 调用小工具 ——
  const mcp = (token: string | undefined, body: unknown, headers: Record<string, string> = {}) =>
    env.app.request("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify(body),
    });
  let rpcId = 0;
  const call = async (token: string, name: string, args: unknown) => {
    const res = await mcp(token, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
    expect(res.status).toBe(200);
    return (await res.json()).result as { content: Array<{ text: string }>; isError?: boolean; structuredContent?: any };
  };

  describe("访问令牌管理", () => {
    it("未登录不能管理令牌", async () => {
      expect((await env.api(undefined, "/api/access-tokens")).status).toBe(401);
      expect((await env.api(undefined, "/api/access-tokens", { method: "POST", body: JSON.stringify({ name: "x" }) })).status).toBe(401);
    });

    it("创建令牌：明文只返回一次，列表里没有明文，库里只有摘要", async () => {
      const res = await env.api(owner, "/api/access-tokens", { method: "POST", body: JSON.stringify({ name: "我的 Claude Code", expiresInDays: 30 }) });
      const body = await res.json();
      expect(res.status).toBe(201);
      ownerToken = body.data.token;
      expect(ownerToken).toMatch(/^aif_[A-Za-z0-9_-]{43}$/);
      expect(body.data.prefix).toBe(ownerToken.slice(0, 8));

      const list = await (await env.api(owner, "/api/access-tokens")).json();
      expect(list.data.items).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain(ownerToken);

      const [row] = await env.db.select().from(accessTokens).where(eq(accessTokens.userId, 990201));
      expect(JSON.stringify(row)).not.toContain(ownerToken);
      expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("参数不合法被拒绝；每个用户最多 5 个有效令牌", async () => {
      expect((await env.api(owner, "/api/access-tokens", { method: "POST", body: JSON.stringify({ name: "  " }) })).status).toBe(400);
      expect((await env.api(owner, "/api/access-tokens", { method: "POST", body: JSON.stringify({ name: "x", expiresInDays: 9999 }) })).status).toBe(400);
      const extra: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await env.api(owner, "/api/access-tokens", { method: "POST", body: JSON.stringify({ name: `t${i}` }) });
        expect(r.status).toBe(201);
        extra.push((await r.json()).data.id);
      }
      const sixth = await env.api(owner, "/api/access-tokens", { method: "POST", body: JSON.stringify({ name: "第六个" }) });
      expect(sixth.status).toBe(400);
      for (const id of extra) expect((await env.api(owner, `/api/access-tokens/${id}`, { method: "DELETE" })).status).toBe(200);
    });

    it("别人的令牌不能撤销，也看不到", async () => {
      const mine = (await (await env.api(owner, "/api/access-tokens")).json()).data.items[0];
      expect((await env.api(other, `/api/access-tokens/${mine.id}`, { method: "DELETE" })).status).toBe(404);
      expect((await (await env.api(other, "/api/access-tokens")).json()).data.items).toHaveLength(0);
      const made = await (await env.api(other, "/api/access-tokens", { method: "POST", body: JSON.stringify({ name: "lisi 的" }) })).json();
      otherToken = made.data.token;
    });
  });

  describe("MCP 认证与协议", () => {
    it("没有令牌、令牌不对、用 cookie 代替令牌，都是 401", async () => {
      const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
      const none = await mcp(undefined, init);
      expect(none.status).toBe(401);
      expect(none.headers.get("www-authenticate")).toMatch(/^Bearer/);
      expect((await mcp("aif_not-a-real-token", init)).status).toBe(401);
      expect((await mcp("random", init)).status).toBe(401);
      expect((await mcp(undefined, init, { Cookie: owner })).status).toBe(401);
    });

    it("initialize、tools/list、通知、GET 的响应", async () => {
      const init = await (await mcp(ownerToken, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
      expect(init.result.serverInfo.name).toBe("all-in-flow");
      const list = await (await mcp(ownerToken, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
      expect(list.result.tools.map((t: any) => t.name)).toEqual(["validate_workflow", "import_workflow"]);
      const note = await mcp(ownerToken, { jsonrpc: "2.0", method: "notifications/initialized" });
      expect(note.status).toBe(202);
      expect(await note.text()).toBe("");
      const get = await env.app.request("/api/mcp", { method: "GET", headers: { Authorization: `Bearer ${ownerToken}` } });
      expect(get.status).toBe(405);
    });

    it("批量请求按顺序返回；不是 JSON 返回 400；过大的请求返回 413", async () => {
      const batch = await (await mcp(ownerToken, [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 3, method: "ping" }])).json();
      expect(batch.map((r: any) => r.id)).toEqual([1, 3]);
      const bad = await env.app.request("/api/mcp", { method: "POST", headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" }, body: "{oops" });
      expect(bad.status).toBe(400);
      const big = await mcp(ownerToken, { jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1024 * 1024 + 10) } });
      expect(big.status).toBe(413);
    });
  });

  describe("validate_workflow", () => {
    it("合法的 IR 通过", async () => {
      const r = await call(ownerToken, "validate_workflow", { ir: salesReport });
      expect(r.isError).toBeUndefined();
      expect(r.content[0]!.text).toContain("校验通过");
      expect(r.structuredContent.nodes).toBe(salesReport.nodes.length);
    });

    it("不合法的 IR 列出问题；ir 也可以是 JSON 字符串；不是对象则提示", async () => {
      const broken = { ...salesReport, edges: salesReport.edges.filter((e) => e.to !== "e") };
      const r = await call(ownerToken, "validate_workflow", { ir: broken });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain("校验未通过");

      const asString = await call(ownerToken, "validate_workflow", { ir: "```json\n" + JSON.stringify(salesReport) + "\n```" });
      expect(asString.isError).toBeUndefined();

      const notJson = await call(ownerToken, "validate_workflow", { ir: "这不是 JSON" });
      expect(notJson.isError).toBe(true);
      expect(notJson.content[0]!.text).toContain("不是合法的 JSON");

      const missing = await call(ownerToken, "validate_workflow", {});
      expect(missing.isError).toBe(true);
    });

    it("校验不会保存任何东西", async () => {
      const rows = await env.db.select().from(workflows).where(inArray(workflows.userId, IDS));
      expect(rows).toHaveLength(0);
    });
  });

  describe("import_workflow", () => {
    let workflowId: string;
    let shareUrl: string;
    let conversationId: string;

    it("校验不通过时不保存", async () => {
      const r = await call(ownerToken, "import_workflow", { ir: { ...salesReport, nodes: [] } });
      expect(r.isError).toBe(true);
      expect(await env.db.select().from(workflows).where(inArray(workflows.userId, IDS))).toHaveLength(0);
    });

    it("首次导入：建会话、工作流第 1 版和分享链接，并带上画像和打分", async () => {
      const r = await call(ownerToken, "import_workflow", {
        ir: salesReport,
        role: { role: "销售运营", systems: ["ERP"] },
        tasks: [{ id: "t1", title: "写周报", frequency: "weekly", minutesPerRun: 210 }],
        painPoints: [
          { id: "p1", taskId: "t1", title: "手工透视", detail: "每周手工做透视表", severity: 4, automatable: 5, evidence: "上周花了 3.5 小时" },
          { id: "p3", taskId: "不存在的工作", title: "孤立痛点", severity: 2, automatable: 2 },
        ],
      });
      expect(r.isError).toBeUndefined();
      ({ shareUrl, workflowId } = r.structuredContent);
      expect(r.structuredContent.version).toBe(1);
      expect(shareUrl).toMatch(/^http:\/\/test\.local\/s\/[A-Za-z0-9_-]{22}$/);
      expect(r.content[0]!.text).toContain(shareUrl);
      conversationId = r.structuredContent.workbenchUrl.split("/c/")[1];

      const [conv] = await env.db.select().from(conversations).where(eq(conversations.id, conversationId));
      expect(conv!.userId).toBe(990201);
      expect(conv!.stage).toBe("generate");
      expect(conv!.title).toBe(`本地导入：${salesReport.name}`);
      const profile = conv!.profile as any;
      expect(profile.importedFrom).toEqual({ source: "skill" });
      expect(profile.painPoints[0].score).toBe(1 * 210 * 4 * 5); // 每周 1 次 × 210 分钟 × 4 × 5
      expect(profile.painPoints[1].taskId).toBeUndefined(); // 悬空引用被去掉
    });

    it("导入时耗时说不准也能打分，并带未量化标记；选了档位就用档位的代表值", async () => {
      const r = await call(ownerToken, "import_workflow", {
        ir: { ...salesReport, name: "耗时说不准" },
        tasks: [
          { id: "a", title: "对账", frequency: "weekly", durationBucket: "unknown" },
          { id: "b", title: "周报", frequency: "weekly", durationBucket: "hours" },
        ],
        painPoints: [
          { id: "pa", taskId: "a", title: "手工匹配", severity: 4, automatable: 5 },
          { id: "pb", taskId: "b", title: "手工汇总", severity: 4, automatable: 5 },
        ],
      });
      expect(r.isError).toBeUndefined();
      const convId = r.structuredContent.workbenchUrl.split("/c/")[1];
      const [conv] = await env.db.select().from(conversations).where(eq(conversations.id, convId));
      const pains = (conv!.profile as any).painPoints;
      expect(pains[0]).toMatchObject({ score: 1 * 30 * 4 * 5, assumed: true });
      expect(pains[1].score).toBe(1 * 90 * 4 * 5);
      expect(pains[1].assumed).toBeUndefined();
    });

    it("链接可用：同事登录后能打开，渲染的是导入的流程；未登录不行", async () => {
      const token = shareUrl.split("/s/")[1];
      expect((await env.api(undefined, `/api/s/${token}`)).status).toBe(401);
      const res = await (await env.api(other, `/api/s/${token}`)).json();
      expect(res.data.name).toBe(salesReport.name);
      expect(res.data.owner).toBe("zhangsan");
      expect(res.data.version).toBe(1);
      expect(res.data.ir.nodes).toHaveLength(salesReport.nodes.length);
    });

    it("工作流出现在用户工作台里，且只属于该用户", async () => {
      const mine = await (await env.api(owner, "/api/workflows")).json();
      expect(mine.data.map((w: any) => w.id)).toContain(workflowId);
      const theirs = await (await env.api(other, "/api/workflows")).json();
      expect(theirs.data.map((w: any) => w.id)).not.toContain(workflowId);
    });

    it("带 workflowId 再导入：保存为第 2 版，链接不变，只有一条分享", async () => {
      const r = await call(ownerToken, "import_workflow", { ir: { ...salesReport, name: "销售周报（改）" }, workflowId });
      expect(r.isError).toBeUndefined();
      expect(r.structuredContent.version).toBe(2);
      expect(r.structuredContent.shareUrl).toBe(shareUrl);
      expect(await env.db.select().from(shares).where(eq(shares.workflowId, workflowId))).toHaveLength(1);
      const token = shareUrl.split("/s/")[1];
      const view = await (await env.api(other, `/api/s/${token}`)).json();
      expect(view.data.version).toBe(2);
      expect(view.data.name).toBe("销售周报（改）");
    });

    it("别人的令牌不能往我的工作流里写；workflowId 格式不对也是错误", async () => {
      const stolen = await call(otherToken, "import_workflow", { ir: salesReport, workflowId });
      expect(stolen.isError).toBe(true);
      expect(stolen.content[0]!.text).toContain("找不到这个工作流");
      const [wf] = await env.db.select().from(workflows).where(eq(workflows.id, workflowId));
      expect(wf!.latestVersion).toBe(2);

      const bad = await call(ownerToken, "import_workflow", { ir: salesReport, workflowId: "not-a-uuid" });
      expect(bad.isError).toBe(true);
    });

    it("会话被删除后，不能再往里导入新版本", async () => {
      await env.db.update(conversations).set({ deletedAt: new Date() }).where(eq(conversations.id, conversationId));
      const r = await call(ownerToken, "import_workflow", { ir: salesReport, workflowId });
      expect(r.isError).toBe(true);
      await env.db.update(conversations).set({ deletedAt: null }).where(eq(conversations.id, conversationId));
    });
  });

  describe("本地 Skill 下载内容", () => {
    it("需要登录；登录后返回文件清单和版本", async () => {
      expect((await env.api(undefined, "/api/local-skill")).status).toBe(401);
      const body = await (await env.api(owner, "/api/local-skill")).json();
      expect(body.data.name).toBe("all-in-flow");
      expect(body.data.version).toMatch(/^[0-9a-f]{12}$/);
      expect(body.data.files.map((f: any) => f.path)).toContain("SKILL.md");
      // 内容里用的是配置的网站地址，且不含任何令牌
      expect(JSON.stringify(body)).toContain("http://test.local/skill");
      expect(JSON.stringify(body)).not.toMatch(/aif_[A-Za-z0-9_-]{20,}/);
    });
  });

  describe("令牌失效", () => {
    it("过期的令牌不能用", async () => {
      const made = await (await env.api(other, "/api/access-tokens", { method: "POST", body: JSON.stringify({ name: "将过期" }) })).json();
      expect((await mcp(made.data.token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
      await env.db.update(accessTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(accessTokens.id, made.data.id));
      expect((await mcp(made.data.token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    });

    it("撤销后立刻失效，并不再出现在列表里", async () => {
      const items = (await (await env.api(owner, "/api/access-tokens")).json()).data.items;
      expect((await env.api(owner, `/api/access-tokens/${items[0].id}`, { method: "DELETE" })).status).toBe(200);
      expect((await mcp(ownerToken, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
      expect((await (await env.api(owner, "/api/access-tokens")).json()).data.items).toHaveLength(0);
      expect((await env.api(owner, `/api/access-tokens/${items[0].id}`, { method: "DELETE" })).status).toBe(404);
    });

    it("使用后记录最近使用时间", async () => {
      const [row] = await env.db.select().from(accessTokens).where(eq(accessTokens.userId, 990202));
      expect(row!.lastUsedAt).not.toBeNull();
    });
  });
});
