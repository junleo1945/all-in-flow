import {
  toMermaid,
  type ExecGraph,
  type ExporterPlugin,
  type ExportFile,
  type ExportIssue,
  type WorkflowIR,
  orderSteps,
  renderSteps,
  type StepNodeType,
} from "@aif/workflow-ir";
import { findIntegration, type IntegrationEntry } from "@aif/integrations";
import { connectionEntries, renderConnections } from "./connections.js";
import { collectSteps, buildFacts, type SkillFacts } from "./facts.js";
import { planScripts, renderEnvExample, type ScriptPlan, type ScriptPlanResult } from "./scripts.js";
import { COMPATIBILITY_LIMIT, DESCRIPTION_LIMIT, FIRST_PERSON, describesWhenToUse } from "./validate.js";
import { SECTION_HEADINGS, SECTION_KEYS, evalsJson, type AuthorDraft } from "./author.js";

export { orderSteps, conditionText } from "@aif/workflow-ir";
export { buildFacts, collectSteps, unconfirmedPaths, type SkillFacts, type FactStep } from "./facts.js";
export { validateSkill, describesWhenToUse, type SkillIssue, type ValidateOptions } from "./validate.js";
export { parseAuthorDraft, evalsJson, SECTION_KEYS, SECTION_HEADINGS, type AuthorDraft, type SectionKey } from "./author.js";

export interface SkillOptions {
  /** 目标 Agent：只影响安装说明，Skill 内容相同 */
  target: "generic" | "claude-code" | "pi";
  /**
   * 打包方式：zip 解压即用（个人试用）；claude-plugin 是 Claude Code 插件，
   * 可以放进公司内部的 git marketplace 统一更新（export-v2.md 7.4）
   */
  packaging?: "zip" | "claude-plugin";
}

const INSTALL_HINT: Record<SkillOptions["target"], string> = {
  generic: "放到 Agent 的 skills 目录中（.agents/skills/ 或对应 Agent 的技能目录）。",
  "claude-code": "解压到 ~/.claude/skills/ 或项目的 .claude/skills/ 目录。",
  pi: "解压到 ~/.pi/agent/skills/ 或项目的 .agents/skills/ 目录。",
};

/**
 * 把工作流编译成 Agent Skill（遵循 agentskills.io 规范）。
 * 结构：SKILL.md + references/workflow.mmd + references/workflow.json（design.md 7.5）。
 */
export const skillExporter: ExporterPlugin<SkillOptions> = {
  type: "exporter",
  id: "skill",
  name: "Agent Skill",
  description: "导出为 Agent Skill，可放进 Claude Code、Pi、Codex 等支持 Agent Skills 规范的 Agent 中运行。",
  version: "1.0.0",
  output: "zip",
  defaultOptions: { target: "generic", packaging: "zip" },

  // action 的内容写进 instructions；确定性步骤另外生成 scripts/（P4）。
  // 没有脚本的 http 步骤、foreach 子流程、并行分支仍以文字说明代替，标为有损
  capabilities: {
    "trigger:manual": "full",
    "trigger:schedule": "full",
    "trigger:event": "full",
    "action:integration": "full",
    "action:http": "full",
    "action:llm": "full",
    "action:transform": "full",
    "action:human": "full",
    "action:none": "full",
    "action:code": "full",
    "decision:llm": "full",
    "decision:expr": "full",
    foreach: "degraded",
    parallel: "degraded",
    merge: "full",
    cycle: "full",
  },

  supports(graph: ExecGraph): ExportIssue[] {
    const ir = graph.ir;
    const issues: ExportIssue[] = [];
    if (!describesWhenToUse(ir.description)) {
      issues.push({ level: "warning", message: "description 没有写明什么时候使用（应包含「……时使用」或 “Use when …”），Agent 可能不会自动触发这个 Skill" });
    }
    if (ir.description.length > DESCRIPTION_LIMIT) {
      issues.push({ level: "warning", message: `description 有 ${ir.description.length} 个字符，超过规范的 ${DESCRIPTION_LIMIT} 个上限，部分 Agent 将无法加载这个 Skill` });
    }
    if (FIRST_PERSON.test(ir.description)) {
      issues.push({ level: "warning", message: "description 应使用第三人称（说明这个 Skill 做什么），不要以「我」「你」开头" });
    }
    const { unsupported } = planScripts(ir, orderSteps(ir).number);
    for (const u of unsupported) {
      issues.push({ level: "warning", nodeId: u.stepId, message: `步骤「${u.title}」无法生成脚本（${u.reason}），将以文字说明导出` });
    }
    for (const i of ir.integrations) {
      const entry = findIntegration(i.id);
      if (!entry) {
        issues.push({ level: "warning", message: `集成「${i.name}」未在集成目录中登记，Skill 中只能写成模型推断的说明。` });
        continue;
      }
      if (!entry.verified && entry.access !== "manual") {
        issues.push({ level: "warning", message: `集成「${i.name}」尚未在真实环境中验证连通性，使用前请先执行连通性检查。` });
      }
      if (entry.access === "manual") {
        issues.push({ level: "warning", message: `集成「${i.name}」需要人工操作，Skill 中只能写成说明，无法自动执行。` });
      }
    }
    if (ir.kind !== "automation") {
      issues.push({ level: "error", message: "只有 automation 类型的工作流可以导出为 Skill。" });
    }
    return issues;
  },

  requirements(graph: ExecGraph): string[] {
    return graph.ir.integrations.flatMap((i) => {
      const entry = findIntegration(i.id);
      if (!entry) return [`${i.name}：${i.hint ?? i.purpose}`];
      return entry.fields.length
        ? entry.fields.map((v) => `${i.name}：需要在本地配置 ${v.name}（${v.description}）`)
        : [`${i.name}：无需额外配置`];
    });
  },

  compile(graph: ExecGraph, options: SkillOptions): ExportFile[] {
    return packageFiles(graph.ir, skeleton(graph.ir, options).files, options);
  },
};

/** 把根目录下的文件放进 zip 里的目录结构：<slug>/…，或 Claude Code 插件的 <slug>/skills/<slug>/… */
export function packageFiles(ir: WorkflowIR, files: ExportFile[], options: Pick<SkillOptions, "packaging">): ExportFile[] {
  const base = ir.slug;
  if (options.packaging === "claude-plugin") {
    // Claude Code 插件：.claude-plugin/plugin.json + skills/<slug>/...
    const plugin = { name: base, version: "1.0.0", description: ir.description };
    return [
      { path: `${base}/.claude-plugin/plugin.json`, content: JSON.stringify(plugin, null, 2) + "\n" },
      ...files.map((f) => ({ ...f, path: `${base}/skills/${base}/${f.path}` })),
    ];
  }
  return files.map((f) => ({ ...f, path: `${base}/${f.path}` }));
}

/** Skill 根目录下的全部文件（路径相对于根目录，不含 zip 外层目录） */
export function skeleton(ir: WorkflowIR, options: SkillOptions): { files: ExportFile[] } & ScriptPlanResult {
  const { plans, unsupported } = planScripts(ir, orderSteps(ir).number);
  const files: ExportFile[] = [
    { path: `SKILL.md`, content: renderSkillMd(ir, plans) },
    { path: `references/workflow.mmd`, content: toMermaid(ir) },
    { path: `references/workflow.json`, content: JSON.stringify(ir, null, 2) + "\n" },
    { path: `INSTALL.md`, content: renderInstall(ir, options, plans) },
  ];
  for (const plan of plans.values()) files.push({ path: plan.path, content: plan.content });
  const env = renderEnvExample(ir);
  if (env) files.push({ path: `.env.example`, content: env });
  const mcp = mcpTemplate(ir);
  if (mcp) files.push({ path: `mcp.json.template`, content: mcp });
  const connections = renderConnections(ir);
  if (connections) files.push({ path: `CONNECTIONS.md`, content: connections });
  return { files, plans, unsupported };
}

/** 给模型和校验器的事实清单。gaps 是导出前仍然空缺的信息 */
export function skillFacts(ir: WorkflowIR, options: SkillOptions, gaps: string[] = []): SkillFacts {
  const { files, plans, unsupported } = skeleton(ir, options);
  return buildFacts(ir, { plans, unsupported, files: files.map((f) => f.path), gaps });
}

// ——— 渲染 ———

const TAG: Record<string, string> = {
  deterministic: "脚本",
  llm: "AI",
  human: "需要确认",
};

const skillTag = (n: StepNodeType) => (n.executor ? `〔${TAG[n.executor]}〕` : undefined);

export function renderSkillMd(ir: WorkflowIR, plans: Map<string, ScriptPlan> = new Map()): string {
  const integrations = ir.integrations;
  const compat = compatibilityText(ir, plans);

  const lines: string[] = [...frontmatterLines(ir, ir.description, compat), "", `# ${ir.name}`, ""];

  lines.push("## 触发方式", "", triggerLine(ir), "");

  if (integrations.length) {
    lines.push("## 前置条件", "");
    for (const i of integrations) {
      const entry = findIntegration(i.id);
      if (!entry) {
        lines.push(`- ${i.name}：${i.purpose}${i.hint ? `（${i.hint}）` : ""}（未在集成目录中登记，请先确认访问方式）`);
        continue;
      }
      const fields = entry.fields.map((v) => `\`${v.name}\``).join("、");
      lines.push(`- ${entry.name}：${entry.summary}${fields ? `。需要在本地配置 ${fields}` : ""}`);
      lines.push(`  - 连通性检查：${entry.verify}`);
      if (entry.access === "api" || entry.access === "cli" || entry.access === "webhook") lines.push("  - 调用方式见 `CONNECTIONS.md`。");
      if (entry.access === "mcp") lines.push("  - 配置方式见 `mcp.json.template`。");
      if (!entry.verified && entry.access !== "manual") lines.push("  - 注意：此集成尚未在真实环境中验证，请先完成连通性检查。");
      if (entry.notes) lines.push(`  - 说明：${entry.notes}`);
    }
    lines.push("");
  }

  if (ir.inputs.length) {
    lines.push("## 输入", "");
    for (const i of ir.inputs) lines.push(`- \`${i.name}\`${i.required ? "（必填）" : "（可选）"}：${i.description}`);
    lines.push("");
  }

  lines.push("## 流程图", "", "见 `references/workflow.mmd`。", "");

  lines.push("## 执行步骤", "", ...stepLines(ir, plans), "");

  const data = dataReferences(ir);
  if (data.length) lines.push(...data, "");

  lines.push("## 执行约定", "");
  lines.push("- 标记〔需要确认〕的步骤，等用户明确回复后再继续。这类步骤需要用户本人判断或操作，替用户回答会让结果不可信。");
  lines.push("- 任何一步失败时，停下来说明失败原因，不要跳过。后面的步骤依赖前面的输出，跳过会让结果悄悄出错。");
  lines.push(
    `- 标记〔脚本〕的步骤，运行对应的脚本${connectionEntries(ir).length ? "，或按 `CONNECTIONS.md` 调用" : ""}，不要凭记忆编造结果。编造的数据看上去正常，却无法核对。`,
  );
  lines.push("- 脚本打印到标准输出的内容就是该步骤的输出。按步骤里「输出」列出的变量名记住它，后面的步骤要用时直接取。");
  if (ir.inputs.length) lines.push("- 「输入」里列出的信息缺失时，先向用户索取，不要自行猜测。");
  lines.push("");

  return lines.join("\n");
}

/** SKILL.md 的 frontmatter。name 固定为 slug，description 由调用方给（模型撰写时用它自己的） */
function frontmatterLines(ir: WorkflowIR, description: string, compat: string | undefined): string[] {
  return [
    "---",
    `name: ${ir.slug}`,
    `description: ${JSON.stringify(description)}`,
    compat ? `compatibility: ${JSON.stringify(compat)}` : undefined,
    "metadata:",
    `  generated-by: all-in-flow`,
    `  workflow-version: "${ir.version}"`,
    "---",
  ].filter((line): line is string => line !== undefined);
}

/** 触发方式一句话。手动触发的说明里已经写了“用户要求”时不再重复补一句 */
function triggerLine(ir: WorkflowIR): string {
  const manualHint = ir.trigger.type === "manual" && !/主动|要求|手动/.test(ir.trigger.detail);
  return `${ir.trigger.detail.replace(/[。.]$/, "")}${manualHint ? "，或用户主动要求时" : ""}。`;
}

/**
 * 用模型撰写的草稿拼出完整的 Skill（路径相对于根目录）：骨架文件不变，SKILL.md 按固定顺序重新拼装，
 * 另外加入模型新增的 references、evals/evals.json，以及 INSTALL.md 末尾的迭代说明。
 */
export function assembleSkill(ir: WorkflowIR, options: SkillOptions, draft: AuthorDraft): { files: ExportFile[] } & ScriptPlanResult {
  const base = skeleton(ir, options);
  const { plans } = base;
  const text = (key: (typeof SECTION_KEYS)[number]) => draft.sections[key];
  const section = (key: (typeof SECTION_KEYS)[number]): string[] => (text(key) ? [`## ${SECTION_HEADINGS[key]}`, "", text(key), ""] : []);

  const data = dataReferences(ir);
  const md = [
    ...frontmatterLines(ir, draft.description, compatibilityText(ir, plans)),
    "",
    `# ${ir.name}`,
    "",
    ...section("overview"),
    "## 触发方式",
    "",
    triggerLine(ir),
    "",
    ...section("prerequisites"),
    ...section("inputs"),
    "## 流程图",
    "",
    "见 `references/workflow.mmd`。",
    "",
    ...section("steps"),
    ...(data.length ? [...data, ""] : []),
    ...section("output"),
    ...section("edgeCases"),
    ...section("conventions"),
  ].join("\n");

  const files = base.files.map((f) => {
    if (f.path === "SKILL.md") return { ...f, content: md };
    if (f.path === "INSTALL.md") return { ...f, content: `${String(f.content).replace(/\s+$/, "")}\n\n${ITERATE_HINT}\n` };
    return f;
  });
  files.push(...draft.references.map((r) => ({ path: r.path, content: r.content.endsWith("\n") ? r.content : `${r.content}\n` })));
  files.push({ path: "evals/evals.json", content: evalsJson(ir.slug, draft) });
  return { ...base, files };
}

const ITERATE_HINT = [
  "## 继续打磨这个 Skill",
  "",
  "`evals/evals.json` 里有 3 条测试提示。想让它更好用，在装有 skill-creator 的 Agent 里打开本目录，说「评测并改进这个 skill」，",
  "它会用这些提示各跑一轮，对比结果并给出修改建议。",
].join("\n");

/** 执行步骤的每一行。foreach 的子流程展开成 3.1、3.2……，子流程里的结束语只针对本轮 */
function stepLines(ir: WorkflowIR, plans: Map<string, ScriptPlan>, prefix = ""): string[] {
  return renderSteps(ir, {
    prefix,
    scripts: plans,
    tag: skillTag,
    endLabels: prefix ? { branch: "本项结束", finish: "本项完成，继续循环中的下一项" } : undefined,
    foreach: (n, label) => ({
      text: `对 \`${n.over}\` 中的每一项（当前项记为 \`${n.item}\`）依次执行下面的子步骤`,
      lines: stepLines({ ...ir, nodes: n.body.nodes, edges: n.body.edges }, plans, `${label}.`).map((l) => `   ${l}`),
    }),
  });
}

/**
 * 「{{n1.orders}}」里的 n1 是节点 id，步骤列表里看不到它，所以单独说明 id 与步骤编号的对应关系，
 * 否则 Agent 无法知道参数该取哪一步的输出。
 */
function dataReferences(ir: WorkflowIR): string[] {
  const all = collectSteps(ir);
  const producers = all.filter(({ node }) => (node.type === "step" || node.type === "foreach") && !!node.outputs?.length);
  const loop = all.find(({ node }) => node.type === "foreach")?.node;
  if (!producers.length && !loop) return [];
  const lines = ["## 数据引用", "", "步骤和脚本参数里的 `{{…}}` 是对数据的引用："];
  if (ir.inputs.length) lines.push("- `{{input.名字}}`：工作流输入，见「输入」。");
  if (producers.length) {
    lines.push("- `{{步骤id.变量名}}`：某个步骤输出的变量。步骤 id 对应的步骤：");
    for (const { node, number } of producers) lines.push(`  - \`${node.id}\` → 第 ${number} 步「${node.title}」`);
  }
  if (loop?.type === "foreach") {
    lines.push(`- \`{{${loop.item}.字段}}\`：循环子步骤里，\`${loop.item}\` 是当前正在处理的那一项，\`{{${loop.item}.字段}}\` 取它的某个字段。`);
  }
  return lines;
}

/**
 * compatibility 写运行环境要求（规范里这一栏的含义），不是依赖的业务系统清单：
 * 脚本需要的解释器、命令行工具、MCP 服务，以及需要联网访问的系统。没有任何要求时不写这一栏。
 */
export function compatibilityText(ir: WorkflowIR, plans: Map<string, ScriptPlan> = new Map()): string | undefined {
  const paths = [...plans.values()].map((p) => p.path);
  const need: string[] = [];
  if (paths.some((p) => p.endsWith(".sh"))) need.push("bash");
  if ([...plans.values()].some((p) => p.content.includes("curl "))) need.push("curl");
  if (paths.some((p) => p.endsWith(".mjs"))) need.push("Node.js 20 及以上");
  if (paths.some((p) => p.endsWith(".py"))) need.push("python3");
  const reach: string[] = [];
  for (const i of ir.integrations) {
    const entry = findIntegration(i.id);
    const access = entry?.access ?? i.access;
    if (access === "cli" && entry?.cli) need.push(`${entry.cli.command} 命令行工具`);
    else if (access === "mcp") need.push(`MCP 服务「${i.name}」`);
    else if (access !== "manual") reach.push(i.name);
  }
  if (reach.length) need.push(`能访问 ${reach.join("、")}`);
  if (!need.length) return undefined;
  const text = `需要：${need.join("、")}`;
  return text.length > COMPATIBILITY_LIMIT ? `${text.slice(0, COMPATIBILITY_LIMIT - 1)}…` : text;
}

/**
 * .mcp.json 模板：地址处只放占位符，使用者在自己的副本中替换为真实地址。
 * 模板本身不含任何真实地址或密钥。
 */
export function mcpTemplate(ir: WorkflowIR): string | undefined {
  const servers = Object.fromEntries(
    ir.integrations
      .map((i) => findIntegration(i.id))
      .filter((e): e is IntegrationEntry => !!e && e.access === "mcp" && !!e.mcp?.urlField)
      .map((e) => [e.mcp!.serverName, { type: e.mcp!.transport, url: `<填写 ${e.mcp!.urlField}>` }]),
  );
  if (Object.keys(servers).length === 0) return undefined;
  return JSON.stringify({ mcpServers: servers }, null, 2) + "\n";
}

/** INSTALL.md 中的 MCP 说明：指向模板文件，不再直接写配置 */
function mcpSnippet(ir: WorkflowIR): string[] {
  if (!mcpTemplate(ir)) return [];
  return [
    "## MCP 配置",
    "",
    "1. 复制 `mcp.json.template` 为项目根目录的 `.mcp.json`（或合并到你已有的 `.mcp.json` 中）。",
    "2. 把模板中 `<填写 …>` 的占位符替换为你自己的服务地址。地址可能包含访问凭证，不要提交到代码仓库。",
    "3. 在 Agent 中确认 MCP 服务已经连接。",
    "",
  ];
}

function renderInstall(ir: WorkflowIR, options: SkillOptions, plans: Map<string, ScriptPlan> = new Map()): string {
  const hasTransform = [...plans.values()].some((p) => p.path.endsWith(".mjs") || p.path.endsWith(".py"));
  const needsScripts = plans.size > 0;
  return [
    `# 安装「${ir.name}」`,
    "",
    INSTALL_HINT[options.target],
    "",
    "## 运行前需要准备",
    "",
    ...(ir.integrations.length
      ? ir.integrations.map((i) => {
          const e = findIntegration(i.id);
          return e ? `- ${e.name}：${e.summary}（需要配置：${e.fields.map((v) => v.name).join("、") || "无"}）` : `- ${i.name}：${i.hint ?? i.purpose}`;
        })
      : ["- 无额外依赖"]),
    "",
    ...(needsScripts
      ? [
          "## 脚本",
          "",
          "- 脚本需要 bash 和 curl（外部接口、Webhook）；命令行工具需要事先安装，见 CONNECTIONS.md。",
          ...(hasTransform ? ["- 数据整理与代码步骤需要 Node.js 20 或更高版本（Python 步骤需要 python3）。"] : []),
          "- 脚本会读取 Skill 根目录下的 `.env`。",
          "",
        ]
      : []),
    ...(renderEnvExample(ir) ? ["## 配置", "", "复制 `.env.example` 为 `.env`，填写其中的值。`.env` 不要提交到代码仓库。", ""] : []),
    ...mcpSnippet(ir),
    "准备好以后，在 Agent 中输入 `/" + ir.slug + "` 或直接描述你的需求即可触发。",
    "",
  ].join("\n");
}