// 提示词评测：用脚本模拟不同类型的用户，和真实模型按提示词对话，再用规则给每轮回复打分。
//
// 用法：
//   node eval/run.mjs --out <报告目录> [--models a,b] [--fixtures f1,f2] [--variants 1.1-full,1.1-short]
//                     [--scenarios cooperative,fabricate] [--concurrency 8] [--baseline <旧版提示词文件>]
//   node eval/summary.mjs <报告目录>...        汇总一个或多个报告目录
// 工作流在 eval/fixtures/<名字>.json，每个工作流的示例数据在 eval/fixtures/meta.json。
// 密钥读取顺序：环境变量 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL，否则从 ENV_FILE（默认主仓库的 .env）读取，不会打印出来。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPrompt } from "../dist/index.js";
import { SCENARIOS, scoreTranscript } from "./scoring.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const outDir = resolve(args.out ?? "eval-report");
const models = (args.models ?? "deepseek-v4.1-flash,deepseek-v4-flash-0731").split(",");
const meta = JSON.parse(readFileSync(resolve(here, "fixtures/meta.json"), "utf8"));
const fixtureNames = (args.fixtures ?? "sales-weekly-chat").split(",");
const onlyVariants = args.variants?.split(",");
const onlyScenarios = args.scenarios?.split(",");
const concurrency = Number(args.concurrency ?? 8);

function loadEnv() {
  if (process.env.DEEPSEEK_API_KEY) return process.env;
  const file = process.env.ENV_FILE ?? "/Users/king/Desktop/owner-king/all-in-flow/.env";
  const env = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}
const env = loadEnv();
const endpoint = `${(env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "")}/chat/completions`;

async function chat(model, messages) {
  // 用 curl 而不是 fetch：超时可靠，且不会因为连接挂起而整个评测停住
  const body = JSON.stringify({ model, messages, temperature: 0.3 });
  const raw = await new Promise((resolveP, reject) => {
    const child = spawn("curl", ["-sS", "--max-time", "240", "-X", "POST", endpoint, "-H", "Content-Type: application/json", "-H", `Authorization: Bearer ${env.DEEPSEEK_API_KEY}`, "--data-binary", "@-"]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolveP(out) : reject(new Error(`curl ${code}: ${err.slice(0, 200)}`))));
    child.stdin.end(body);
  });
  const json = JSON.parse(raw);
  if (!json.choices) throw new Error(`API: ${JSON.stringify(json).slice(0, 200)}`);
  const content = json.choices[0].message.content;
  if (!content) throw new Error("模型返回了空内容");
  return content;
}

async function runConversation(model, promptText, turnsText) {
  const messages = [{ role: "system", content: promptText }];
  const turns = [];
  for (const u of turnsText) {
    messages.push({ role: "user", content: u });
    turns.push({ role: "user", content: u });
    const reply = await chat(model, messages);
    messages.push({ role: "assistant", content: reply });
    turns.push({ role: "assistant", content: reply });
  }
  return turns;
}

// 任务列表：模型 × 工作流 × 提示词版本 × 场景
const jobs = [];
for (const fixture of fixtureNames) {
  const ir = JSON.parse(readFileSync(resolve(here, `fixtures/${fixture}.json`), "utf8"));
  const variants = { "1.1-full": renderPrompt(ir, { variant: "full" }), "1.1-short": renderPrompt(ir, { variant: "short" }) };
  if (args.baseline) variants["1.0-full"] = readFileSync(args.baseline, "utf8");
  for (const model of models) {
    for (const [variant, promptText] of Object.entries(variants)) {
      if (onlyVariants && !onlyVariants.includes(variant)) continue;
      for (const [scenario, def] of Object.entries(SCENARIOS)) {
        if (onlyScenarios && !onlyScenarios.includes(scenario)) continue;
        jobs.push({ model, fixture, variant, scenario, promptText, turns: def.turns(meta[fixture]) });
      }
    }
  }
}

mkdirSync(outDir, { recursive: true });
const results = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const key = `${job.model} | ${job.fixture} | ${job.variant} | ${job.scenario}`;
    try {
      const turns = await runConversation(job.model, job.promptText, job.turns);
      const metrics = scoreTranscript(turns, job.promptText, job.scenario);
      results.push({ model: job.model, fixture: job.fixture, variant: job.variant, scenario: job.scenario, metrics });
      const file = `${job.model.replace(/\//g, "_")}__${job.fixture}__${job.variant}__${job.scenario}.md`;
      writeFileSync(resolve(outDir, file), turns.map((t) => `### ${t.role === "user" ? "用户" : "AI"}\n\n${t.content}`).join("\n\n"));
      console.log("ok", key);
    } catch (e) {
      results.push({ model: job.model, fixture: job.fixture, variant: job.variant, scenario: job.scenario, error: String(e.message ?? e) });
      console.log("ERR", key, String(e.message ?? e).slice(0, 160));
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
writeFileSync(resolve(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log("saved", outDir, `${results.filter((r) => !r.error).length}/${results.length} 成功`);
