import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { setupTestApp } from "./helpers.js";
import { conversations, users, workflows, workflowVersions, shares, sessionEntries, authSessions, usageDaily } from "../src/db/schema/index.js";
import { createConversation, saveProfile } from "../src/db/repos/conversationRepo.js";
import { createWorkflow } from "../src/db/repos/workflowRepo.js";
import { emptyProfile, upsertPainPoint, upsertTask } from "../src/domain/profile.js";
import { salesReport } from "./fixtures.js";

const url = process.env.DATABASE_URL;
const IDS = [990201, 990202];

describe.skipIf(!url)("分享、画像编辑、用量、管理员（真实数据库）", () => {
  let env: Awaited<ReturnType<typeof setupTestApp>>;
  let owner: string;
  let other: string;
  let admin: string;
  let wfId: string;
  let convId: string;

  beforeAll(async () => {
    env = await setupTestApp(url!);
    // 清理上一轮残留
    await env.db.delete(usageDaily).where(inArray(usageDaily.userId, IDS));
    await env.db.delete(authSessions).where(inArray(authSessions.userId, IDS));
    await env.db.insert(users).values([
      { id: 990201, username: "zhangsan", displayName: "zhangsan" },
      { id: 990202, username: "lisi", displayName: "lisi" },
    ]).onConflictDoNothing();
    owner = await env.login("zhangsan");
    other = await env.login("lisi");
    admin = owner;

    const conv = await createConversation(env.db, 990201, "周报");
    convId = conv.id;
    const profile = emptyProfile();
    const task = upsertTask(profile, { title: "周报", frequency: "weekly", minutesPerRun: 210 });
    upsertPainPoint(profile, { title: "手工透视", detail: "", severity: 4, automatable: 5, taskId: task.id });
    await saveProfile(env.db, convId, profile);
    const wf = await createWorkflow(env.db, 990201, convId, { ...salesReport, source: { painPointIds: [profile.painPoints[0]!.id] } });
    wfId = wf.workflowId;
  });

  afterAll(async () => {
    if (!env) return;
    await env.db.delete(shares).where(eq(shares.userId, 990201));
    const wfs = await env.db.select({ id: workflows.id }).from(workflows).where(inArray(workflows.userId, IDS));
    for (const w of wfs) await env.db.delete(workflowVersions).where(eq(workflowVersions.workflowId, w.id));
    await env.db.delete(workflows).where(inArray(workflows.userId, IDS));
    const convs = await env.db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.userId, IDS));
    for (const c of convs) await env.db.delete(sessionEntries).where(eq(sessionEntries.conversationId, c.id));
    await env.db.delete(conversations).where(inArray(conversations.userId, IDS));
    await env.db.delete(usageDaily).where(inArray(usageDaily.userId, IDS));
    await env.db.delete(authSessions).where(inArray(authSessions.userId, IDS));
    await env.db.delete(users).where(inArray(users.id, IDS));
    await env.sql.end();
  });

  let token: string;

  it("作者创建公司内分享，返回链接", async () => {
    const res = await env.api(owner, `/api/workflows/${wfId}/shares`, { method: "POST", body: JSON.stringify({ version: 1, expiresInDays: 7 }) });
    const body = await res.json();
    expect(res.status).toBe(201);
    token = body.data.token;
    expect(token).toHaveLength(22);
    expect(body.data.url).toBe(`http://test.local/s/${token}`);
  });

  it("公司内分享：未登录 401，已登录可读，且不含对话记录", async () => {
    const anon = await env.api(undefined, `/api/s/${token}`);
    expect(anon.status).toBe(401);
    const res = await env.api(other, `/api/s/${token}`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.name).toBe(salesReport.name);
    expect(body.data.owner).toBe("zhangsan");
    expect(JSON.stringify(body.data)).not.toMatch(/messages|session_entries|profile/);
    expect(body.data.painPoints).toBeUndefined(); // 默认不分享痛点
  });

  it("访问次数递增", async () => {
    const rows = await env.db.select().from(shares).where(eq(shares.token, token));
    expect(rows[0]!.viewCount).toBeGreaterThanOrEqual(1);
  });

  it("公开分享在管理员未开启时返回 403", async () => {
    const res = await env.api(owner, `/api/workflows/${wfId}/shares`, { method: "POST", body: JSON.stringify({ visibility: "public" }) });
    expect(res.status).toBe(403);
  });

  it("复制到工作台：新建会话并标记导入来源", async () => {
    const res = await env.api(other, `/api/s/${token}/fork`, { method: "POST" });
    expect(res.status).toBe(201);
    const { conversationId, workflowId } = (await res.json()).data;
    const [conv] = await env.db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect((conv!.profile as any).importedFrom.name).toBe(salesReport.name);
    expect(conv!.stage).toBe("generate");
    const [wf] = await env.db.select().from(workflows).where(eq(workflows.id, workflowId));
    expect(wf!.forkedFromShareId).toBeTruthy();
    expect(wf!.userId).toBe(990202);
  });

  it("撤销后分享返回 410", async () => {
    const list = await (await env.api(owner, "/api/shares")).json();
    const id = list.data.find((s: any) => s.token === token).id;
    await env.api(owner, `/api/shares/${id}`, { method: "DELETE" });
    const res = await env.api(owner, `/api/s/${token}`);
    expect(res.status).toBe(410);
  });

  it("过期的分享返回 410", async () => {
    const created = await (await env.api(owner, `/api/workflows/${wfId}/shares`, { method: "POST", body: JSON.stringify({ expiresInDays: 7 }) })).json();
    await env.db.update(shares).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(shares.token, created.data.token));
    expect((await env.api(owner, `/api/s/${created.data.token}`)).status).toBe(410);
  });

  it("包含痛点摘要时只返回与该方案关联的痛点", async () => {
    const created = await (await env.api(owner, `/api/workflows/${wfId}/shares`, { method: "POST", body: JSON.stringify({ includePainPoints: true }) })).json();
    const res = await (await env.api(owner, `/api/s/${created.data.token}`)).json();
    expect(res.data.painPoints.map((p: any) => p.title)).toEqual(["手工透视"]);
  });

  it("非所属用户不能给别人的工作流建分享", async () => {
    const res = await env.api(other, `/api/workflows/${wfId}/shares`, { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(404);
  });

  it("画像手动编辑会重算痛点分数", async () => {
    const detail = await (await env.api(owner, `/api/conversations/${convId}`)).json();
    const pid = detail.data.profile.painPoints[0].id;
    const res = await env.api(owner, `/api/conversations/${convId}/profile`, {
      method: "PATCH",
      body: JSON.stringify({ painPoints: [{ id: pid, severity: 1, automatable: 1 }] }),
    });
    const body = await res.json();
    expect(body.data.painPoints[0].severity).toBe(1);
    // 每周 1 次 × 210 分钟 × 痛苦 1 × 可自动化 1
    expect(body.data.painPoints[0].score).toBe(210);
  });

  it("用户信息包含今日用量与配额", async () => {
    const info = await (await env.api(owner, "/api/user/info")).json();
    expect(info.data.usage.dailyTokenQuota).toBe(2_000_000);
    expect(typeof info.data.usage.tokensToday).toBe("number");
  });

  it("管理员可以查看用量，普通用户 403", async () => {
    expect((await env.api(admin, "/api/admin/usage")).status).toBe(200);
    expect((await env.api(other, "/api/admin/usage")).status).toBe(403);
  });
});
