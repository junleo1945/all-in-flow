// 提示词评测：用脚本模拟不同类型的用户，和真实模型按提示词对话，再用规则给每轮回复打分。
//
// 用法：
//   node eval/run.mjs --out <报告目录> [--baseline <1.0 版提示词文件>] [--models deepseek-v4.1-flash,deepseek-v4-flash-0731] [--fixture sales-weekly|sales-weekly-chat]
// 密钥读取顺序：环境变量 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL，否则从 ENV_FILE（默认主仓库的 .env）读取，不会打印出来。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPrompt } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const outDir = resolve(args.out ?? "eval-report");
const models = (args.models ?? "deepseek-v4.1-flash,deepseek-v4-flash-0731").split(",");
// 可以只跑部分组合（补跑用）：--variants 1.1-full,1.0-full --scenarios partial
const onlyVariants = args.variants?.split(",");
const onlyScenarios = args.scenarios?.split(",");

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

const ir = JSON.parse(readFileSync(resolve(here, `fixtures/${args.fixture ?? "sales-weekly"}.json`), "utf8"));
const variants = {
  "1.1-full": renderPrompt(ir, { variant: "full" }),
  "1.1-short": renderPrompt(ir, { variant: "short" }),
};
if (args.baseline) variants["1.0-full"] = readFileSync(args.baseline, "utf8");

// 模拟用户：每个场景的发言是固定的，用来比较不同提示词在同样输入下的表现
const SCENARIOS = {
  cooperative: {
    label: "配合型：按步骤操作，给数据，接受建议",
    turns: [
      "开始吧，这周的周报我要做。",
      "我在 ERP 里导出了本周订单，结果粘贴如下：\nSO-001 金额 1200 状态 normal\nSO-002 金额 560 状态 abnormal\nSO-003 金额 2300 状态 normal",
      "异常的标准就用状态 abnormal。",
      "确认计入。",
      "周报的格式你先给一个简单的，我看看。",
    ],
  },
  novice: {
    label: "不懂业务型：不知道怎么取数，让 AI 替自己定标准",
    turns: [
      "我不太懂这个流程，你带我做吧。",
      "ERP 那边我不知道怎么导，你直接告诉我怎么做。",
      "你帮我定一个异常的标准吧。",
      "行，就按你说的来。",
      "你随便定个周报格式就行。",
    ],
  },
  partial: {
    label: "数据不全型：只给一部分数据，中途才补充",
    turns: [
      "开始。",
      "订单就这三条：SO-001 1200 normal；SO-002 560 abnormal。",
      "标准你来定，我都行。",
      "就按你的来，计入。",
      "还有一条 SO-004 金额 800 normal，补上。",
    ],
  },
};

// ——— 规则打分（每个指标都是可以复现的简单规则） ———

const JARGON = /接口|API|字段|参数|端点|调用/;
const INTERNAL_REF = /\{\{|\b[a-z]+\d+\.[a-zA-Z]\w*/;
const REFUSE = /不能替你定|不能帮你定|不能自己定|不替你定|不能擅自定/;
const SUGGEST = /建议|推荐|选项|口径/;
const NAG = /遗漏|漏了|有没有漏|是否齐全/;
const BIG_NUM = /\d{3,}/g;

function scoreTranscript(turns, promptText) {
  const replies = turns.filter((t) => t.role === "assistant").map((t) => t.content);
  const userText = turns.filter((t) => t.role === "user").map((t) => t.content).join("\n");
  const count = (re) => replies.filter((r) => re.test(r)).length;
  const numbers = replies.flatMap((r) => r.match(BIG_NUM) ?? []);
  const unseen = numbers.filter((n) => !userText.includes(n) && !promptText.includes(n));
  return {
    turns: replies.length,
    progress_marker: count(/当前[:：]/) / Math.max(replies.length, 1),
    questions_per_reply: replies.reduce((s, r) => s + (r.match(/[？?]/g) ?? []).length, 0) / Math.max(replies.length, 1),
    avg_chars: Math.round(replies.reduce((s, r) => s + r.length, 0) / Math.max(replies.length, 1)),
    jargon_replies: count(JARGON),
    internal_ref_replies: count(INTERNAL_REF),
    refused_to_suggest: count(REFUSE),
    gave_suggestions: count(SUGGEST),
    nag_after_data: replies.slice(1).filter((r) => NAG.test(r)).length,
    numbers_not_in_input: unseen.length,
  };
}

async function chat(model, messages) {
  // 用 curl 而不是 fetch：超时可靠，且不会因为连接挂起而整个评测停住
  const body = JSON.stringify({ model, messages, temperature: 0.3 });
  const raw = await new Promise((resolveP, reject) => {
    const child = spawn("curl", ["-sS", "--max-time", "150", "-X", "POST", endpoint, "-H", "Content-Type: application/json", "-H", `Authorization: Bearer ${env.DEEPSEEK_API_KEY}`, "--data-binary", "@-"]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolveP(out) : reject(new Error(`curl ${code}: ${err.slice(0, 200)}`))));
    child.stdin.end(body);
  });
  const json = JSON.parse(raw);
  if (!json.choices) throw new Error(`API: ${JSON.stringify(json).slice(0, 200)}`);
  return json.choices[0].message.content;
}

async function runConversation(model, promptText, scenario) {
  const messages = [{ role: "system", content: promptText }];
  const turns = [];
  for (const u of scenario.turns) {
    messages.push({ role: "user", content: u });
    turns.push({ role: "user", content: u });
    const reply = await chat(model, messages);
    messages.push({ role: "assistant", content: reply });
    turns.push({ role: "assistant", content: reply });
  }
  return turns;
}

const results = [];
mkdirSync(outDir, { recursive: true });
for (const model of models) {
  for (const [vname, promptText] of Object.entries(variants)) {
    if (onlyVariants && !onlyVariants.includes(vname)) continue;
    for (const [sname, scenario] of Object.entries(SCENARIOS)) {
      if (onlyScenarios && !onlyScenarios.includes(sname)) continue;
      const key = `${model} | ${vname} | ${sname}`;
      try {
        const turns = await runConversation(model, promptText, scenario);
        const metrics = scoreTranscript(turns, promptText);
        results.push({ model, variant: vname, scenario: sname, metrics });
        writeFileSync(resolve(outDir, `${model}__${vname}__${sname}.md`), turns.map((t) => `### ${t.role === "user" ? "用户" : "AI"}\n\n${t.content}`).join("\n\n"));
        console.log("ok", key);
      } catch (e) {
        results.push({ model, variant: vname, scenario: sname, error: String(e.message ?? e) });
        console.log("ERR", key, String(e.message ?? e).slice(0, 160));
      }
    }
  }
}
writeFileSync(resolve(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log("saved", outDir);
