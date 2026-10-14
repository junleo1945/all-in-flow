// 用当前的打分规则重新给已有的对话记录打分（不重新请求模型）：node eval/rescore.mjs <报告目录>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPrompt } from "../dist/index.js";
import { scoreTranscript } from "./scoring.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(process.argv[2]);
const results = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".md") && x.includes("__") && x !== "summary.md")) {
  const [model, fixture, variant, rest] = f.replace(/\.md$/, "").split("__");
  const scenario = rest;
  const ir = JSON.parse(readFileSync(resolve(here, `fixtures/${fixture}.json`), "utf8"));
  const promptText = renderPrompt(ir, { variant: variant.endsWith("short") ? "short" : "full" });
  const parts = readFileSync(resolve(dir, f), "utf8").split(/### (用户|AI)\n\n/).slice(1);
  const turns = [];
  for (let i = 0; i < parts.length; i += 2) turns.push({ role: parts[i] === "用户" ? "user" : "assistant", content: parts[i + 1].trim() });
  results.push({ model, fixture, variant, scenario, metrics: scoreTranscript(turns, promptText, scenario) });
}
writeFileSync(resolve(dir, "results.json"), JSON.stringify(results, null, 2));
console.log("rescored", results.length);
