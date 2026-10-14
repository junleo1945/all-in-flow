/**
 * 写入一份演示数据：用户 zhangsan 的一次访谈，包含画像、痛点和工作流（v1、v2）。
 * 用于在没有 DeepSeek Key 的环境里检查工作台、画布、导出和分享。
 * 用法：DATABASE_URL=... npx tsx scripts/seed-demo.ts
 * 必须指定一个已经登录过的真实账号（用户记录由登录时从 ERP 创建），脚本不会创建任何用户：
 *   SEED_USERNAME=<ERP 用户名> DATABASE_URL=... npx tsx scripts/seed-demo.ts
 */
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { users, conversations, workflows, workflowVersions, sessionEntries } from "../src/db/schema/index.js";
import { emptyProfile, upsertPainPoint, upsertTask } from "../src/domain/profile.js";
import { createConversation, saveProfile } from "../src/db/repos/conversationRepo.js";
import { createWorkflow, addVersion } from "../src/db/repos/workflowRepo.js";
import type { WorkflowIR } from "@aif/workflow-ir";
import { salesReport } from "../test/fixtures.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL 未配置");
await runMigrations(url);
const { db, sql } = createDb(url);

const username = process.env.SEED_USERNAME;
if (!username) throw new Error("请用 SEED_USERNAME 指定要写入数据的真实账号（该账号需要先登录过一次）");
const [user] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
if (!user) throw new Error(`用户 ${username} 不存在，请先用该账号登录一次再运行`);
const USER_ID = user.id;

// 清掉这个用户之前的演示数据
const old = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.userId, USER_ID));
for (const c of old) {
  await db.delete(sessionEntries).where(eq(sessionEntries.conversationId, c.id));
  const wfs = await db.select({ id: workflows.id }).from(workflows).where(eq(workflows.conversationId, c.id));
  for (const w of wfs) await db.delete(workflowVersions).where(eq(workflowVersions.workflowId, w.id));
  await db.delete(workflows).where(eq(workflows.conversationId, c.id));
  await db.delete(conversations).where(eq(conversations.id, c.id));
}

const conv = await createConversation(db, USER_ID, "销售周报");
const profile = emptyProfile();
profile.role = { role: "销售运营", team: "华南销售部", systems: ["ERP", "Excel", "钉钉"], summary: "一半时间花在整理数据上。" };
const weekly = upsertTask(profile, { title: "销售周报", frequency: "weekly", minutesPerRun: 210, systems: ["ERP", "Excel"] });
const daily = upsertTask(profile, { title: "订单跟进", frequency: "daily", minutesPerRun: 60, systems: ["钉钉"] });
const monthly = upsertTask(profile, { title: "月度对账", frequency: "monthly", minutesPerRun: 240, systems: ["Excel"] });
const p1 = upsertPainPoint(profile, { title: "手工导出并透视订单数据", detail: "每次都要重新设一遍透视表", severity: 4, automatable: 5, evidence: "每次都要重新设一遍透视表，字段还经常变", taskId: weekly.id });
upsertPainPoint(profile, { title: "挨个找销售核对异常单", detail: "一个个私聊，回复慢的要催好几次", severity: 4, automatable: 3, evidence: "一个个私聊，回复慢的要催好几次", taskId: daily.id });
upsertPainPoint(profile, { title: "催单消息分散在多个群里", detail: "经常漏看", severity: 3, automatable: 3, evidence: "经常漏看，客户第二天又来问", taskId: daily.id });
upsertPainPoint(profile, { title: "月底对账反复改表", detail: "财务口径一变，整张表都要重做", severity: 5, automatable: 4, evidence: "财务口径一变，整张表都要重做", taskId: monthly.id });
await saveProfile(db, conv.id, profile, "generate");

const ir: WorkflowIR = {
  ...salesReport,
  source: { painPointIds: [p1.id], savedMinutesPerWeek: 180 },
};
const wf = await createWorkflow(db, USER_ID, conv.id, ir);
const v2: WorkflowIR = {
  ...ir,
  nodes: ir.nodes.map((n) => (n.id === "n3" ? { ...n, title: "预览并确认异常" } : n)),
  description: ir.description + "（v2：增加预览确认）",
};
await addVersion(db, USER_ID, wf.workflowId, v2);

console.log(JSON.stringify({ conversationId: conv.id, workflowId: wf.workflowId, versions: 2 }));
await sql.end();
