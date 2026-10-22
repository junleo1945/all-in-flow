import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { checkExport, lower, migrateIr, toMermaid, validateWorkflow, type ExportFile, type WorkflowIR } from "@aif/workflow-ir";
import { skillExporter, validateSkill } from "@aif/plugin-exporter-skill";
import { promptExporter, SHORT_LIMIT } from "@aif/plugin-exporter-prompt";
import { setupTestApp } from "./helpers.js";
import { accessTokens, authSessions, conversations, sessionEntries, shares, usageDaily, users, workflows, workflowVersions } from "../src/db/schema/index.js";
import { BROKEN, DEMOS, LEGACY_V1, weeklySalesReport } from "./demos.js";

/**
 * 演示全链路测试：不调用真实模型，用假模型脚本化访谈，其余环节（HTTP、数据库、校验、
 * MCP、分享、导出）全部走真实代码。演示用的工作流见 demos.ts。
 */

const url = process.env.DATABASE_URL;
const IDS = [990201, 990202];
const text = (f: ExportFile) => (typeof f.content === "string" ? f.content : new TextDecoder().decode(f.content));

// ——— 一、纯函数层：每个演示工作流的校验、流程图、导出（不需要数据库） ———

describe.each(DEMOS)("演示工作流「$key」：校验与导出", ({ ir }) => {
  it("通过校验，没有警告", () => {
    const r = validateWorkflow(ir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toEqual([]);
  });

  it("能生成 Mermaid 流程图，包含每个顶层节点的标题", () => {
    const mmd = toMermaid(ir);
    expect(mmd.startsWith("flowchart")).toBe(true);
    for (const n of ir.nodes) expect(mmd, n.title).toContain(n.title);
  });

  it("对话提示词：能导出完整版与精简版，内容干净", () => {
    const graph = lower(ir);
    expect(checkExport(promptExporter, graph).filter((i) => i.level === "error")).toEqual([]);
    const files = promptExporter.compile(graph, {});
    expect(files.map((f) => f.path)).toEqual([`${ir.slug}.prompt.md`, `${ir.slug}.prompt-short.md`]);
    const [full, short] = files.map(text) as [string, string];
    expect(full).toContain(ir.name);
    expect(short.length).toBeLessThan(full.length);
    expect(short.length).toBeLessThanOrEqual(SHORT_LIMIT);
    for (const body of [full, short]) {
      expect(body).not.toMatch(/\[object Object\]|\bundefined\b|\bnull\b/);
      expect(body).not.toContain("{{");
    }
  });

  it(ir.kind === "automation" ? "Agent Skill：能导出并通过 Skill 校验器" : "Agent Skill：人工流程（process）被明确拒绝，而不是导出一个残缺的包", () => {
    const graph = lower(ir);
    const issues = checkExport(skillExporter, graph);
    if (ir.kind === "process") {
      expect(issues.some((i) => i.level === "error")).toBe(true);
      return;
    }
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    const files = skillExporter.compile(graph, { target: "generic" });
    const prefix = `${ir.slug}/`;
    const skillFiles = files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
    expect(skillFiles.map((f) => f.path)).toContain("SKILL.md");
    expect(validateSkill(skillFiles).filter((i) => i.level === "error")).toEqual([]);
    // 不能带出任何密钥样的内容
    expect(files.map(text).join("\n")).not.toMatch(/sk-[A-Za-z0-9]{16,}|aif_[A-Za-z0-9_-]{20,}/);
  });
});

describe("旧版数据与坏数据", () => {
  it("v1 数据读取时迁移成 v2，且能通过校验", () => {
    const v2 = migrateIr(LEGACY_V1);
    expect(v2.version).toBe(2);
    expect(validateWorkflow(v2).ok).toBe(true);
    expect(validateWorkflow(LEGACY_V1).ok).toBe(true); // 校验器也直接接受 v1
  });

  it.each(BROKEN)("校验器拒绝：$key", ({ ir, expect: reason }) => {
    const r = validateWorkflow(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.message).join("；")).toMatch(reason);
  });
});

// ——— 二、HTTP + 数据库：从访谈到导入、分享、复制、改版本 ———

describe.skipIf(!url)("演示全链路（真实数据库 + 假模型）", () => {
  let env: Awaited<ReturnType<typeof setupTestApp>>;
  let owner: string;
  let colleague: string;
  let mcpToken: string;

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
    env = await setupTestApp(url!, {}, { generateIr: async () => ({ ir: weeklySalesReport, warnings: [] }) });
    await clean();
    await env.db.insert(users).values([
      { id: 990201, username: "zhangsan", displayName: "zhangsan" },
      { id: 990202, username: "lisi", displayName: "lisi" },
    ]).onConflictDoNothing();
    owner = await env.login("zhangsan");
    colleague = await env.login("lisi");
  });

  afterAll(async () => {
    if (!env) return;
    await clean();
    await env.db.delete(users).where(inArray(users.id, IDS));
    await env.sql.end();
  });

  const json = async (res: Response) => (await res.json()) as any;
  const mcp = (token: string, body: unknown) =>
    env.app.request("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  let rpcId = 0;
  const call = async (name: string, args: unknown) => {
    const res = await mcp(mcpToken, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
    expect(res.status).toBe(200);
    return (await res.json()).result as { content: Array<{ text: string }>; isError?: boolean; structuredContent?: any };
  };

  describe("1. 访谈：假模型脚本化走完 画像 → 痛点 → 方案 → 生成工作流", () => {
    let convId: string;
    let workflowId: string;

    it("新建会话", async () => {
      const res = await env.api(owner, "/api/conversations", { method: "POST" });
      expect(res.status).toBe(201);
      convId = (await json(res)).data.id;
    });

    it("第 1 轮：记录角色、工作、痛点，并提出方案（提出方案后本轮结束，等用户选择；done 最后）", async () => {
      env.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("update_profile", { role: "销售运营", team: "华南销售部", systems: ["ERP", "Excel"] }),
            fauxToolCall("record_task", { id: "t1", title: "销售周报", frequency: "weekly", minutesPerRun: 210, systems: ["ERP", "Excel"] }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          [fauxToolCall("record_pain_point", { id: "p1", taskId: "t1", title: "手工导出并透视订单", detail: "每次都要重设透视表", severity: 4, automatable: 5, evidence: "每次都要重新设一遍透视表" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          [fauxToolCall("propose_workflows", { candidates: [{ title: "周报自动汇总", painPointIds: ["p1"], summary: "自动取数并成文", savedMinutesPerWeek: 150, systems: ["ERP"] }] })],
          { stopReason: "toolUse" },
        ),
      ]);
      const res = await env.api(owner, `/api/conversations/${convId}/messages`, { method: "POST", body: JSON.stringify({ text: "我是华南销售运营，每周五要做销售周报，大概三个半小时" }) });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const body = await res.text();
      for (const ev of ["event: tool", "event: state_patch", "event: usage", "event: done"]) expect(body, ev).toContain(ev);
      expect(body.trimEnd().endsWith("data: {}")).toBe(true);
      expect(body.lastIndexOf("event: done")).toBeGreaterThan(body.lastIndexOf("event: usage"));

      const detail = await json(await env.api(owner, `/api/conversations/${convId}`));
      const profile = detail.data.profile;
      expect(profile.role.role).toBe("销售运营");
      expect(profile.tasks.map((t: any) => t.title)).toEqual(["销售周报"]);
      // 每周 1 次 × 210 分钟 × 痛苦 4 × 可自动化 5
      expect(profile.painPoints[0].score).toBe(1 * 210 * 4 * 5);
      expect(profile.candidates).toHaveLength(1);
    });

    it("第 2 轮：选定方案后生成工作流（v1），出现在工作台列表", async () => {
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("emit_workflow", { brief: "周报自动汇总：取数、筛异常、人工确认、成文" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("工作流已生成。"),
      ]);
      const res = await env.api(owner, `/api/conversations/${convId}/messages`, { method: "POST", body: JSON.stringify({ text: "就按这个方案生成" }) });
      const body = await res.text();
      expect(body).toContain("event: workflow");
      expect(body).toContain("event: done");

      const list = await json(await env.api(owner, "/api/workflows"));
      const mine = list.data.find((w: any) => w.name === weeklySalesReport.name);
      expect(mine).toBeTruthy();
      workflowId = mine.id;
      const v1 = await json(await env.api(owner, `/api/workflows/${workflowId}/versions/1`));
      expect(v1.data.ir).toEqual(weeklySalesReport);
    });

    it("历史消息可回放，用量已统计", async () => {
      const msgs = await json(await env.api(owner, `/api/conversations/${convId}/messages`));
      expect(JSON.stringify(msgs.data)).toContain("我是华南销售运营");
      const info = await json(await env.api(owner, "/api/user/info"));
      expect(typeof info.data.usage.tokensToday).toBe("number");
    });
  });

  describe("2. 本地 Skill + 平台 MCP：把四个演示工作流全部导入", () => {
    const imported: Array<{ key: string; workflowId: string; shareUrl: string; ir: WorkflowIR }> = [];

    it("网页端生成访问令牌，MCP 握手并列出工具", async () => {
      const made = await json(await env.api(owner, "/api/access-tokens", { method: "POST", body: JSON.stringify({ name: "演示用", expiresInDays: 7 }) }));
      mcpToken = made.data.token;
      const init = await (await mcp(mcpToken, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
      expect(init.result.serverInfo.name).toBe("all-in-flow");
      const list = await (await mcp(mcpToken, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
      expect(list.result.tools.map((t: any) => t.name)).toEqual(["validate_workflow", "import_workflow"]);
    });

    it("本地 Skill 可下载，且不含令牌", async () => {
      const body = await json(await env.api(owner, "/api/local-skill"));
      expect(body.data.files.map((f: any) => f.path)).toContain("SKILL.md");
      expect(JSON.stringify(body)).not.toContain(mcpToken);
    });

    it.each(DEMOS)("校验并导入「$key」", async ({ key, ir }) => {
      const checked = await call("validate_workflow", { ir });
      expect(checked.isError).toBeUndefined();
      const r = await call("import_workflow", {
        ir,
        role: { role: "销售运营", systems: ["ERP"] },
        tasks: [{ id: "t1", title: key, frequency: "weekly", durationBucket: "hours" }],
        // 痛点 id 要和 ir.source.painPointIds 对得上，分享时才能带出关联的痛点
        painPoints: [{ id: ir.source.painPointIds[0], taskId: "t1", title: `${key}太耗时`, severity: 4, automatable: 4 }],
      });
      expect(r.isError).toBeUndefined();
      expect(r.structuredContent.shareUrl).toMatch(/^http:\/\/test\.local\/s\/[A-Za-z0-9_-]{22}$/);
      imported.push({ key, ir, workflowId: r.structuredContent.workflowId, shareUrl: r.structuredContent.shareUrl });
    });

    it("坏数据导入被拒绝、不落库，错误信息可读", async () => {
      const before = (await json(await env.api(owner, "/api/workflows"))).data.length;
      for (const b of BROKEN.filter((x) => typeof x.ir === "object")) {
        const r = await call("import_workflow", { ir: b.ir });
        expect(r.isError, b.key).toBe(true);
        expect(r.content[0]!.text).toContain("校验未通过");
      }
      expect((await json(await env.api(owner, "/api/workflows"))).data.length).toBe(before);
    });

    it("入库后读回的 IR 与原数据完全一致，并且读回的数据仍能完成导出（数据库往返不丢信息）", async () => {
      for (const d of imported) {
        const v = await json(await env.api(owner, `/api/workflows/${d.workflowId}/versions/1`));
        expect(v.data.ir, d.key).toEqual(d.ir);
        const graph = lower(v.data.ir as WorkflowIR);
        expect(promptExporter.compile(graph, {}).length, d.key).toBe(2);
      }
    });

    it("同事登录后用链接看到流程图；未登录不行；他的工作台里没有这些工作流", async () => {
      for (const d of imported) {
        const token = d.shareUrl.split("/s/")[1]!;
        expect((await env.api(undefined, `/api/s/${token}`)).status, d.key).toBe(401);
        const view = await json(await env.api(colleague, `/api/s/${token}`));
        expect(view.data.name).toBe(d.ir.name);
        expect(view.data.ir.nodes).toHaveLength(d.ir.nodes.length);
        expect(view.data.owner).toBe("zhangsan");
      }
      expect((await json(await env.api(colleague, "/api/workflows"))).data).toEqual([]);
    });

    it("同事把「报销核对」复制到自己的工作台，之后互不影响", async () => {
      const target = imported.find((d) => d.key === "报销核对")!;
      const token = target.shareUrl.split("/s/")[1]!;
      const fork = await env.api(colleague, `/api/s/${token}/fork`, { method: "POST" });
      expect(fork.status).toBe(201);
      const mine = (await json(await env.api(colleague, "/api/workflows"))).data;
      expect(mine.map((w: any) => w.name)).toContain(target.ir.name);
      // 作者改了新版本，同事手里的副本不变
      const edited = { ...target.ir, name: "报销单核对流程（作者改）" };
      expect((await env.api(owner, `/api/workflows/${target.workflowId}/versions`, { method: "POST", body: JSON.stringify({ ir: edited }) })).status).toBeLessThan(300);
      const copyId = mine.find((w: any) => w.name === target.ir.name).id;
      const copy = await json(await env.api(colleague, `/api/workflows/${copyId}/versions/1`));
      expect(copy.data.ir.name).toBe(target.ir.name);
    });

    it("画布里改动并保存为新版本：合法的成功，非法的 400，旧版本不动", async () => {
      const target = imported.find((d) => d.key === "晨间邮件")!;
      const edited = { ...target.ir, description: target.ir.description + "（v2）" };
      const ok = await env.api(owner, `/api/workflows/${target.workflowId}/versions`, { method: "POST", body: JSON.stringify({ ir: edited }) });
      expect(ok.status).toBeLessThan(300);
      const bad = await env.api(owner, `/api/workflows/${target.workflowId}/versions`, { method: "POST", body: JSON.stringify({ ir: { ...target.ir, edges: [] } }) });
      expect(bad.status).toBe(400);
      const listed = (await json(await env.api(owner, `/api/workflows/${target.workflowId}/versions`))).data;
      expect(listed.latestVersion).toBe(2);
      expect(listed.versions).toHaveLength(2);
      const v1 = await json(await env.api(owner, `/api/workflows/${target.workflowId}/versions/1`));
      expect(v1.data.ir.description).toBe(target.ir.description);
    });

    it("分享管理：创建带痛点摘要的分享 → 列表可见 → 撤销后 410", async () => {
      const target = imported.find((d) => d.key === "销售周报")!;
      const created = await json(await env.api(owner, `/api/workflows/${target.workflowId}/shares`, { method: "POST", body: JSON.stringify({ includePainPoints: true, expiresInDays: 7 }) }));
      const token = created.data.token as string;
      const view = await json(await env.api(colleague, `/api/s/${token}`));
      expect(view.data.painPoints?.length).toBeGreaterThan(0);
      const mine = (await json(await env.api(owner, "/api/shares"))).data;
      const row = mine.find((s: any) => s.token === token);
      expect(row).toBeTruthy();
      expect((await env.api(owner, `/api/shares/${row.id}`, { method: "DELETE" })).status).toBe(200);
      expect((await env.api(colleague, `/api/s/${token}`)).status).toBe(410);
    });

    it("跨用户隔离：同事不能读、改、分享别人的工作流", async () => {
      const target = imported[0]!;
      expect((await env.api(colleague, `/api/workflows/${target.workflowId}/versions`)).status).toBe(404);
      expect((await env.api(colleague, `/api/workflows/${target.workflowId}/versions`, { method: "POST", body: JSON.stringify({ ir: target.ir }) })).status).toBe(404);
      expect((await env.api(colleague, `/api/workflows/${target.workflowId}/shares`, { method: "POST", body: JSON.stringify({}) })).status).toBe(404);
    });
  });

  describe("3. 账号与配额", () => {
    it("登录信息、用量与配额；未登录 401；退出后会话失效", async () => {
      expect((await env.api(undefined, "/api/user/info")).status).toBe(401);
      const info = await json(await env.api(owner, "/api/user/info"));
      expect(info.data.usage.dailyTokenQuota).toBe(2_000_000);
      const lisi = await env.login("lisi");
      expect((await env.api(lisi, "/api/user/logout", { method: "POST" })).status).toBe(200);
      expect((await env.api(lisi, "/api/user/info")).status).toBe(401);
    });

    it("管理员能看全站用量，普通用户 403", async () => {
      expect((await env.api(owner, "/api/admin/usage")).status).toBe(200);
      const lisi = await env.login("lisi");
      expect((await env.api(lisi, "/api/admin/usage")).status).toBe(403);
    });
  });
});
