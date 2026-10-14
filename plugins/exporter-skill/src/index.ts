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
import { planScripts, renderEnvExample, type ScriptPlan } from "./scripts.js";

export { orderSteps, conditionText } from "@aif/workflow-ir";

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
    if (!/时使用|时才使用|时调用/.test(ir.description)) {
      issues.push({ level: "warning", message: "description 没有写明什么时候使用（应包含「……时使用」），Agent 可能不会自动触发这个 Skill" });
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
    const ir = graph.ir;
    const base = ir.slug;
    const { plans } = planScripts(ir, orderSteps(ir).number);
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

    if (options.packaging === "claude-plugin") {
      // Claude Code 插件：.claude-plugin/plugin.json + skills/<slug>/...
      const plugin = { name: base, version: "1.0.0", description: ir.description };
      return [
        { path: `${base}/.claude-plugin/plugin.json`, content: JSON.stringify(plugin, null, 2) + "\n" },
        ...files.map((f) => ({ ...f, path: `${base}/skills/${base}/${f.path}` })),
      ];
    }
    return files.map((f) => ({ ...f, path: `${base}/${f.path}` }));
  },
};

// ——— 渲染 ———

const TAG: Record<string, string> = {
  deterministic: "脚本",
  llm: "AI",
  human: "需要确认",
};

const skillTag = (n: StepNodeType) => (n.executor ? `〔${TAG[n.executor]}〕` : undefined);

export function renderSkillMd(ir: WorkflowIR, plans: Map<string, ScriptPlan> = new Map()): string {
  const integrations = ir.integrations;

  const frontmatter = [
    "---",
    `name: ${ir.slug}`,
    `description: ${JSON.stringify(ir.description)}`,
    integrations.length
      ? `compatibility: ${JSON.stringify(`需要：${integrations.map((i) => i.name).join("、")}`)}`
      : undefined,
    "metadata:",
    `  generated-by: all-in-flow`,
    `  workflow-version: "${ir.version}"`,
    "---",
  ].filter((line): line is string => line !== undefined);

  const lines: string[] = [...frontmatter, "", `# ${ir.name}`, ""];

  lines.push("## 触发方式", "", `${ir.trigger.detail}${ir.trigger.type === "manual" ? "，或用户主动要求时" : ""}。`, "");

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

  lines.push("## 执行步骤", "", ...renderSteps(ir, { scripts: plans, tag: skillTag }), "");

  lines.push("## 执行约定", "");
  lines.push("- 标记〔需要确认〕的步骤，必须等用户回复后才能继续。");
  lines.push("- 任何一步失败时，停下来说明失败原因，不要跳过。");
  lines.push("- 标记〔脚本〕的步骤优先使用确定性的命令或接口调用，不要凭记忆编造结果。");
  lines.push("");

  return lines.join("\n");
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