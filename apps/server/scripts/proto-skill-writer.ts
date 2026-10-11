/**
 * 原型：用 Pi 会话 + skill-creator 的起草原则，改写模板生成的 SKILL.md 正文。
 * 只改正文，脚本和参数保持模板原样；输出写到 SCRATCH 目录，并做结构校验。
 * 用法：set -a; source ../../.env; set +a; npx tsx scripts/proto-skill-writer.ts [输出目录]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lower, type WorkflowIR } from "@aif/workflow-ir";
import { skillExporter } from "@aif/plugin-exporter-skill";
import { salesReport } from "../test/fixtures.js";
import { createRuntime, resolveModel } from "../src/agent/models.js";
import { createInterviewSession } from "../src/agent/session.js";

const outDir = process.argv[2] ?? "/private/tmp/claude-501/-Users-king-Desktop-owner-king-all-in-flow/0baddeb1-694c-43d1-8772-7a7414affcef/scratchpad/proto";
mkdirSync(outDir, { recursive: true });

const ir: WorkflowIR = salesReport;
const files = skillExporter.compile(lower(ir), { target: "generic", packaging: "zip" });
const skeleton = (name: string) => {
  const f = files.find((x) => x.path === `${ir.slug}/${name}`);
  if (!f) throw new Error(`骨架中没有 ${name}`);
  return f.content as string;
};
const skeletonSkill = skeleton("SKILL.md");
const scriptPaths = files
  .map((f) => f.path.replace(`${ir.slug}/`, ""))
  .filter((p) => p.startsWith("scripts/"));

// skill-creator 起草部分的原则（摘自 ~/.agents/skills/skill-creator/SKILL.md 的 Skill Writing Guide 与 Writing Style）
const WRITER_PRINCIPLES = `你是 Skill 起草者。任务：改写一份 Agent Skill 的 SKILL.md 正文，让它更清楚、更容易被 Agent 正确执行。

起草原则：
- 正文用祈使句，写清楚每一步做什么、为什么要做。尽量解释原因，少用堆砌的 MUST / 禁止。
- description 要写清"做什么 + 什么时候用"，并包含"……时使用"，方便 Agent 自动触发。
- 保持 SKILL.md 简洁，目标在 500 行以内。
- 不要编造流程中没有的步骤，不要改变步骤顺序和分支条件。
- 骨架的步骤说明是把几段话直接拼在一起的，读起来断续。请把每一步改写成一两句通顺的话：说清楚输入、要做的动作和产出；"完成后进入第 N 步"这类衔接语改成自然的表述。`;

const HARD_RULES = `硬性约束（违反任何一条都会被拒绝）：
1. frontmatter 的 name 必须与原文一致；description 可以改写措辞，但必须保留"时使用"。
2. 执行步骤的编号、数量和顺序不变；每一步的标题（**…**）保持原文。
3. 原文中出现的 \`scripts/...\` 路径和脚本参数（反引号内容）必须原样保留，不许改名或删除。
4. 〔脚本〕〔AI〕〔需要确认〕等标记保留；"执行约定"一节保留。
5. 不得新增任何 http(s) 地址、密钥或真实账号；只能使用原文已有的 <填写 …> 占位符。
6. 只输出完整的 SKILL.md，放在一个 \`\`\`markdown 代码块里，不要输出其他解释。`;

const runtime = await createRuntime({
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL,
  // 与服务端一致：自定义模型清单相对项目根目录
  modelsJsonPath: resolve("../..", process.env.MODELS_JSON_PATH ?? "config/models.json"),
});
const model = resolveModel(runtime, process.env.WORKFLOW_MODEL ?? "deepseek/deepseek-v4-pro");

const session = await createInterviewSession({
  cwd: outDir,
  model,
  modelRuntime: runtime,
  systemPrompt: `${WRITER_PRINCIPLES}\n\n${HARD_RULES}`,
  tools: [],
});

const userPrompt = `工作流描述：${ir.description}

可用脚本（已由模板生成，只能引用，不能修改）：
${scriptPaths.map((p) => `- ${p}`).join("\n") || "- 无"}

下面是模板生成的骨架 SKILL.md，请改写正文：
<skeleton>
${skeletonSkill}
</skeleton>`;

const started = Date.now();
await session.prompt(userPrompt, { expandPromptTemplates: false });
const raw = session.getLastAssistantText() ?? "";
session.dispose();
console.log(`模型耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

const match = raw.match(/```markdown\n([\s\S]*)\n```/);
const aiSkill = match ? match[1]! : raw;
writeFileSync(join(outDir, "SKILL.skeleton.md"), skeletonSkill);
writeFileSync(join(outDir, "SKILL.ai.md"), aiSkill);
writeFileSync(join(outDir, "raw-output.txt"), raw);

// ——— 结构校验 ———
const checks: [string, boolean][] = [];
const stepCount = (s: string) => (s.match(/^\d+\. \*\*/gm) ?? []).length;
const stepTitles = (s: string) => [...s.matchAll(/^\d+\. \*\*(.+?)\*\*/gm)].map((m) => m[1]!.replace(/〔.*〕/, "").trim());
const urls = (s: string) => new Set(s.match(/https?:\/\/[^\s)`"]+/g) ?? []);

checks.push(["代码块提取成功", !!match]);
checks.push(["frontmatter name 一致", new RegExp(`^name: ${ir.slug}$`, "m").test(aiSkill)]);
checks.push(["description 含「时使用」", /description:.*时使用/.test(aiSkill)]);
checks.push([`步骤数量一致（${stepCount(skeletonSkill)}）`, stepCount(aiSkill) === stepCount(skeletonSkill)]);
const titlesOk = stepTitles(skeletonSkill).every((t) => aiSkill.includes(t));
checks.push(["步骤标题全部保留", titlesOk]);
checks.push(["脚本路径全部保留", scriptPaths.every((p) => aiSkill.includes(p))]);
const newUrls = [...urls(aiSkill)].filter((u) => !urls(skeletonSkill).has(u));
checks.push([`没有新增地址${newUrls.length ? `（新增：${newUrls.join(", ")}）` : ""}`, newUrls.length === 0]);
checks.push(["执行约定保留", aiSkill.includes("执行约定")]);
checks.push(["行数 ≤ 500", aiSkill.split("\n").length <= 500]);

console.log("\n结构校验：");
for (const [label, ok] of checks) console.log(`  ${ok ? "✅" : "❌"} ${label}`);
console.log(`\n骨架行数 ${skeletonSkill.split("\n").length}，AI 版行数 ${aiSkill.split("\n").length}`);
console.log(`输出目录：${outDir}`);
