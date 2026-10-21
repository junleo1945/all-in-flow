/**
 * 给已有工作流补写 chatInstructions（聊天场景下给用户看的操作说明），保存为新版本。
 * 只处理每个工作流的最新版本，已经有说明的步骤不会改动。默认只预览，加 --apply 才写入。
 * 用法：
 *   DATABASE_URL=... DEEPSEEK_API_KEY=... DEEPSEEK_BASE_URL=... \
 *     pnpm --filter @aif/server exec tsx scripts/backfill-chat-instructions.ts [--apply] [--user <用户 id>]
 * 模型取 WORKFLOW_MODEL（默认 deepseek/deepseek-v4-pro），模型配置取 MODELS_JSON_PATH。
 */
import { and, eq } from "drizzle-orm";
import { migrateIr, validateWorkflow } from "@aif/workflow-ir";
import { createDb } from "../src/db/client.js";
import { workflows, workflowVersions } from "../src/db/schema/index.js";
import { addVersion } from "../src/db/repos/workflowRepo.js";
import { createRuntime, resolveModel } from "../src/agent/models.js";
import { backfillChatInstructions, createAsk, missingChatSteps } from "../src/agent/chatBackfill.js";

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
  if (missing === 0) continue;

  const { ir: next, filled } = await backfillChatInstructions(ir, ask);
  const check = validateWorkflow(next);
  if (filled === 0 || !check.ok) {
    console.log(`跳过 ${wf.id}「${wf.name}」：缺 ${missing} 步，补写 ${filled} 步${check.ok ? "" : "，校验未通过"}`);
    continue;
  }
  console.log(`${apply ? "写入" : "预览"} ${wf.id}「${wf.name}」v${wf.latestVersion}：补写 ${filled}/${missing} 步`);
  for (const n of next.nodes) if (n.type === "step" && n.chatInstructions && !(ir.nodes.find((o) => o.id === n.id) as any)?.chatInstructions) console.log(`  - ${n.title}：${n.chatInstructions}`);
  if (apply) {
    const v = await addVersion(db, wf.userId, wf.id, check.ir);
    console.log(`  已保存为 v${v}`);
  }
  changed += 1;
}
console.log(`${apply ? "已更新" : "可更新"} ${changed} 个工作流（共 ${rows.length} 个）`);
await sql.end();
