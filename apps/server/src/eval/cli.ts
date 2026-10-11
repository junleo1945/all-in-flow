/**
 * 评测入口：对每个人设跑一次模拟访谈，输出指标和对话记录。
 * 用法：DATABASE_URL=... DEEPSEEK_API_KEY=... npx tsx src/eval/cli.ts [--persona sales-ops] [--max-turns 20] [--out dir] [--baseline file]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PERSONAS, summarize, compare, toMarkdown } from "@aif/evals";
import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { createDb } from "../db/client.js";
import { users } from "../db/schema/index.js";
import { createRuntime, resolveModel } from "../agent/models.js";
import { createIrGenerator } from "../agent/irGenerator.js";
import { runEval } from "./runner.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = loadConfig();
await runMigrations(config.databaseUrl);
const { db, sql } = createDb(config.databaseUrl);
const EVAL_USER_ID = 990900;
await db.insert(users).values({ id: EVAL_USER_ID, username: "eval-bot", displayName: "评测机器人" }).onConflictDoNothing();

const runtime = await createRuntime({ deepseekApiKey: config.deepseekApiKey, deepseekBaseUrl: config.deepseekBaseUrl, modelsJsonPath: config.modelsJsonPath });
const agentModel = resolveModel(runtime, config.agentModel);
const userModel = resolveModel(runtime, flag("user-model") ?? config.agentModel);
const workflowModel = resolveModel(runtime, config.workflowModel);

const personaId = flag("persona");
const personas = personaId ? PERSONAS.filter((p) => p.id === personaId) : PERSONAS;
if (personas.length === 0) throw new Error(`找不到人设：${personaId}`);

const results = await runEval(
  {
    db,
    runtime,
    agentModel,
    userModel,
    generateIr: createIrGenerator({ runtime, model: workflowModel }),
    maxTurns: Number(flag("max-turns") ?? 20),
    evalUserId: EVAL_USER_ID,
    log: (m) => console.log(m),
  },
  personas,
);

const metrics = results.map((r) => r.metrics);
const summary = summarize(metrics);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(flag("out") ?? "../../packages/evals/reports", stamp);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "results.json"), JSON.stringify({ summary, metrics, transcripts: results.map((r) => ({ id: r.metrics.personaId, transcript: r.transcript })) }, null, 2));
const md = toMarkdown(metrics, summary);
writeFileSync(join(outDir, "report.md"), md + "\n");

const baselineFile = flag("baseline");
if (baselineFile) {
  const base = JSON.parse(readFileSync(baselineFile, "utf8")).summary;
  writeFileSync(join(outDir, "compare.json"), JSON.stringify(compare(summary, base), null, 2));
}

console.log(md);
console.log(`\n报告已写入 ${outDir}`);
await sql.end();
