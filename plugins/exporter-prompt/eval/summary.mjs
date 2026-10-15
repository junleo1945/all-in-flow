// 汇总评测结果：node eval/summary.mjs <报告目录>...
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dirs = process.argv.slice(2);
const rows = dirs.flatMap((d) => JSON.parse(readFileSync(resolve(d, "results.json"), "utf8")));
const ok = rows.filter((r) => !r.error);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (x, d = 2) => (Number.isNaN(x) ? "-" : x.toFixed(d));
const pct = (x) => (Number.isNaN(x) ? "-" : `${Math.round(x * 100)}%`);
const groupBy = (list, key) => list.reduce((m, r) => ((m[key(r)] ??= []).push(r), m), {});
const lines = [];
const out = (s = "") => lines.push(s);

out(`# 评测汇总\n\n共 ${rows.length} 组对话，成功 ${ok.length} 组，失败 ${rows.length - ok.length} 组。\n`);

out("## 按模型与提示词版本\n");
out("| 模型 | 版本 | 对话数 | 进度标记 | 每轮问号 | 平均字数 | 含术语回复 | 含内部引用回复 | 步骤跳跃 | 凭空数字 |");
out("|---|---|---|---|---|---|---|---|---|---|");
for (const [k, g] of Object.entries(groupBy(ok, (r) => `${r.model}|${r.variant}`))) {
  const [model, variant] = k.split("|");
  const m = (name) => mean(g.map((r) => r.metrics[name]));
  out(`| ${model} | ${variant} | ${g.length} | ${pct(m("progress_marker"))} | ${f(m("questions_per_reply"))} | ${f(m("avg_chars"), 0)} | ${f(m("jargon_replies"))} | ${f(m("internal_ref_replies"))} | ${f(m("step_jumps"))} | ${f(m("numbers_not_in_input"))} |`);
}

out("\n## 拒绝编造数据（场景：要求编造）\n");
out("| 模型 | 版本 | 对话数 | 明确拒绝编造 | 实际编出数据 |");
out("|---|---|---|---|---|");
for (const [k, g] of Object.entries(groupBy(ok.filter((r) => r.scenario === "fabricate"), (r) => `${r.model}|${r.variant}`))) {
  const [model, variant] = k.split("|");
  out(`| ${model} | ${variant} | ${g.length} | ${pct(mean(g.map((r) => r.metrics.refused_fabrication)))} | ${pct(mean(g.map((r) => r.metrics.fabricated)))} |`);
}

out("\n## 守住步骤顺序（场景：要求跳步）\n");
out("| 模型 | 版本 | 对话数 | 说明不能跳过 | 实际跳到后面 |");
out("|---|---|---|---|---|");
for (const [k, g] of Object.entries(groupBy(ok.filter((r) => r.scenario === "skip"), (r) => `${r.model}|${r.variant}`))) {
  const [model, variant] = k.split("|");
  out(`| ${model} | ${variant} | ${g.length} | ${pct(mean(g.map((r) => r.metrics.held_the_line)))} | ${pct(mean(g.map((r) => r.metrics.skipped_ahead)))} |`);
}

out("\n## 按工作流\n");
out("| 工作流 | 对话数 | 进度标记 | 每轮问号 | 含术语回复 | 步骤跳跃 |");
out("|---|---|---|---|---|---|");
for (const [fixture, g] of Object.entries(groupBy(ok, (r) => r.fixture))) {
  const m = (name) => mean(g.map((r) => r.metrics[name]));
  out(`| ${fixture} | ${g.length} | ${pct(m("progress_marker"))} | ${f(m("questions_per_reply"))} | ${f(m("jargon_replies"))} | ${f(m("step_jumps"))} |`);
}

const bad = rows.filter((r) => r.error);
if (bad.length) {
  out("\n## 失败的对话\n");
  for (const r of bad) out(`- ${r.model} | ${r.fixture} | ${r.variant} | ${r.scenario}：${r.error.slice(0, 100)}`);
}
const text = lines.join("\n");
console.log(text);
writeFileSync(resolve(dirs[0], "summary.md"), text);
