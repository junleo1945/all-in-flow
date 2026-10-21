/**
 * 给已有工作流补写聊天场景需要的两类说明，保存为新版本：
 *   1. chatInstructions：程序化步骤「在哪个系统做什么」的操作说明；
 *   2. 循环项的字段说明（Variable.fields）：把「当前这一项的 name」写成「候选人姓名」。
 * 这两个字段是后加的，导出对话提示词前创建的工作流都没有。
 * 只处理每个工作流的最新版本，已经有说明的内容不会改动，可以重复运行。默认只预览，加 --apply 才写入。
 * 用法：
 *   DATABASE_URL=... DEEPSEEK_API_KEY=... DEEPSEEK_BASE_URL=... \
 *     pnpm --filter @aif/server exec tsx scripts/backfill-chat-instructions.ts [--apply] [--user <用户 id>]
 * 模型取 WORKFLOW_MODEL（默认 deepseek/deepseek-v4-pro），模型配置取 MODELS_JSON_PATH。
 */
import { and, eq } from "drizzle-orm";
import { migrateIr, validateWorkflow } from "@aif/workflow-ir";
import { findOperation } from "@aif/integrations";
import { createDb } from "../src/db/client.js";
import { workflows, workflowVersions } from "../src/db/schema/index.js";
import { addVersion } from "../src/db/repos/workflowRepo.js";
import { createRuntime, resolveModel } from "../src/agent/models.js";
import { backfillChatInstructions, backfillItemFields, createAsk, listItemFields, missingChatSteps, missingItemFields } from "../src/agent/chatBackfill.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL 未配置");
const apply = process.argv.includes("--apply");
const userArg = process.argv.indexOf("--user");
const onlyUser = userArg >= 0 ? Number(process.argv[userArg + 1]) : undefined;

const { db, sql } = createDb(url);
const runtime = await createRuntime({
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL,
  modelsJsonPath: process.env.MODELS_JSON_PATH,
});
const ask = createAsk({ runtime, model: resolveModel(runtime, process.env.WORKFLOW_MODEL || "deepseek/deepseek-v4-pro") });

const rows = await db.select().from(workflows).where(onlyUser ? eq(workflows.userId, onlyUser) : undefined);
let changed = 0;
for (const wf of rows) {
  const [row] = await db
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.workflowId, wf.id), eq(workflowVersions.version, wf.latestVersion)));
  if (!row) continue;
  const ir = migrateIr(row.ir);
  const missing = missingChatSteps(ir).length;
  const missingFields = missingItemFields(ir).reduce((s, m) => s + m.fields.length, 0);
  if (missing === 0 && missingFields === 0) continue;

  const step1 = await backfillChatInstructions(ir, ask);
  const step2 = await backfillItemFields(step1.ir, ask);
  const next = step2.ir;
  const filled = step1.filled + step2.filled;
  const check = validateWorkflow(next, { resolveOperation: findOperation });
  if (filled === 0 || !check.ok) {
    console.log(`跳过 ${wf.id}「${wf.name}」：缺 ${missing} 步说明、${missingFields} 个字段说明，补写 ${step1.filled} 步、${step2.filled} 个字段${check.ok ? "" : "，校验未通过"}`);
    continue;
  }
  console.log(`${apply ? "写入" : "预览"} ${wf.id}「${wf.name}」v${wf.latestVersion}：补写 ${step1.filled}/${missing} 步说明、${step2.filled}/${missingFields} 个字段说明`);
  for (const n of next.nodes) if (n.type === "step" && n.chatInstructions && !(ir.nodes.find((o) => o.id === n.id) as any)?.chatInstructions) console.log(`  - ${n.title}：${n.chatInstructions}`);
  const before = new Set(listItemFields(ir));
  for (const line of listItemFields(next)) if (!before.has(line)) console.log(`  - ${line}`);
  if (apply) {
    const v = await addVersion(db, wf.userId, wf.id, check.ir);
    console.log(`  已保存为 v${v}`);
  }
  changed += 1;
}
console.log(`${apply ? "已更新" : "可更新"} ${changed} 个工作流（共 ${rows.length} 个）`);
await sql.end();
